import { RequestFailedError, isBackendUnreachable, isNoAnswer, type FailureCopy } from '../../lib/errorCopy';
import { MoodboardVersionConflict } from '../../lib/moodboardEdits';
import type { StudioNotice } from '../../store/assetStudioDraftStore';
import { clipGraphemes } from './boardPlaceholder';

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
   *  no button: sending the same edit again fails the same way, and the
   *  line's own step is outside the board (signed out: open the link Nebula
   *  printed, as the banner says; changed somewhere else: reload, after
   *  which the kept edit replays on the latest version, GM r17). */
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
  signedOut: { cause: 'you’re signed out', step: 'Open the link Nebula printed when it started.', retry: 'reload' },
  changed: { cause: 'it changed somewhere else', step: 'Reload to get the latest version.', retry: 'reload' },
  // GM r16 7(b): any other refusal, the create id's included.
  refused: { cause: 'the server didn’t accept this save', step: 'Try again.', retry: 'save' },
} as const satisfies Record<string, { cause: string; step: string; retry: BoardSaveLine['retry'] }>;

type SaveLineKind = keyof typeof SAVE_LINES;

/**
 * Whether a failed save found its board deleted (round 6l, GM r21 Q3): a 404
 * whose `code` is "in_trash" is in Recently deleted ('trashed', the r18
 * neutral line with Restore); any other 404 is gone for good ('purged', the
 * red line). Never "didn’t accept this save. Try again.": Retry can't work.
 */
export function boardGoneKind(error: unknown): 'trashed' | 'purged' | null {
  if (!(error instanceof RequestFailedError) || error.status !== 404) return null;
  const detail = error.detail as { code?: unknown } | null | undefined;
  return error.code === 'in_trash' || (typeof detail === 'object' && detail?.code === 'in_trash') ? 'trashed' : 'purged';
}

/** Which of GM's lines a failed board save gets, from its status and fields (a 404 is boardGoneKind's). */
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

/** The line and the header's offer for a board save that failed. A save that found its board deleted says
 *  the deleted-board line for `name` (the board's saved name), with no Retry: it can never work (GM r21 Q3). */
export function boardSaveLine(error: unknown, name = ''): BoardSaveLine {
  const gone = boardGoneKind(error);
  if (gone) return { failure: { heading: '', reason: deletedBoardsLine([name], gone).text }, retry: 'reload' };
  const line = SAVE_LINES[saveLineKind(error)];
  return { failure: { heading: '', reason: `${NOT_SAVED_OPENING}${line.cause}. ${line.step}` }, retry: line.retry };
}

/** The line alone (boardSaveLine's failure). */
export function boardSaveFailure(error: unknown, name = ''): FailureCopy {
  return boardSaveLine(error, name).failure;
}

/** The clause after "because" for a board's save that failed. */
export function boardSaveCause(error: unknown): string {
  const gone = boardGoneKind(error);
  if (gone) return gone === 'trashed' ? 'the board was deleted' : 'the board was deleted somewhere else';
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
  sendNotes: 'notes setting', analysis: 'analysis', cover: 'cover',
};

/**
 * The line for kept edits whose boards were deleted before they could
 * replay (round 6j, GM r18), named as the Kept lines are: up to three
 * names, each clipped past KEPT_NAME_MAX, joined with "and", then a count;
 * the title holds every full name.
 * - In Recently deleted (neutral, with Restore): "Nebula couldn’t save your
 *   change to “Rivers” because the board was deleted. Restore it to keep
 *   the change."; for several, "Nebula couldn’t save your changes to “A”
 *   and “B” because they were deleted. Restore them to keep the changes."
 * - Gone for good (red, no Retry): "Nebula couldn’t save your change to
 *   “Rivers” because the board was deleted somewhere else."; for several,
 *   "…your changes to 4 moodboards because they were deleted somewhere else."
 */
export function deletedBoardsLine(names: readonly string[], gone: 'trashed' | 'purged'): { text: string; title: string } {
  const { one, what, title } = namedBoards(names);
  // Each form spelled out whole, as GM wrote it (and so no sentence is pieced from parts).
  const text = gone === 'trashed'
    ? (one ? `Nebula couldn’t save your change to ${what} because the board was deleted. Restore it to keep the change.`
      : `Nebula couldn’t save your changes to ${what} because they were deleted. Restore them to keep the changes.`)
    : (one ? `Nebula couldn’t save your change to ${what} because the board was deleted somewhere else.`
      : `Nebula couldn’t save your changes to ${what} because they were deleted somewhere else.`);
  return { text, title };
}

/**
 * The confirmation once the boards a deleted-board line named are restored
 * (round 6l, GM r20 A, r21 Q6), named by the names the line and the list
 * showed, in two sentences; the second counts the boards whose kept edit was
 * sent and saved, and goes when none was (nothing left to send: the board
 * kept every change, and its "Kept …" line follows). A plain Restore from
 * Recently deleted, with no kept edit, is the first sentence alone.
 * - "Restored “Rivers”. Your change is saved."
 * - "Restored “Rivers” and “Harbor”. Your changes are saved."
 * - "Restored 4 moodboards. Your changes are saved."
 * - "Restored “Rivers”."
 */
export function restoredBoardsLine(names: readonly string[], saved: number, stayed = ''): { text: string; title: string } {
  const { what, title } = namedBoards(names);
  // Each form spelled out whole; a kept remove that didn't replay adds changedAfterRemoveLine's sentence (GM r90.5).
  const text = saved === 0 ? `Restored ${what}.`
    : saved === 1 ? `Restored ${what}. Your change is saved.`
      : `Restored ${what}. Your changes are saved.`;
  return { text: stayed ? `${text} ${stayed}` : text, title };
}

/**
 * The line for kept edits whose boards' project is in Recently deleted
 * (round 6l, GM r21 Q8; round 6p, GM r90.2): one line per project, naming
 * the project and its boards by the names rule (one; up to three joined;
 * then a count), neutral, with "Restore project". The title lists every
 * board, then the project, with no colon (GM r74).
 * - "Nebula couldn’t save your change to “Rivers” because its project
 *   “Coast” was deleted. Restore the project to keep the change."
 * - "Nebula couldn’t save your changes to “Rivers” and “Tide” because their
 *   project “Coast” was deleted. Restore the project to keep the changes."
 * - "…your changes to 4 moodboards because their project “Coast” was deleted…"
 */
export function projectDeletedLine(project: string, boards: readonly string[]): { text: string; title: string } {
  const { what, title } = namedBoards([project]);
  const kept = namedBoards(boards.length ? boards : ['']);
  // Each form spelled out whole.
  const text = kept.one
    ? `Nebula couldn’t save your change to ${kept.what} because its project ${what} was deleted. Restore the project to keep the change.`
    : `Nebula couldn’t save your changes to ${kept.what} because their project ${what} was deleted. Restore the project to keep the changes.`;
  return { text, title: `${kept.title} in ${title}` };
}

/**
 * The red line for kept edits whose boards' project was deleted for good
 * somewhere else (round 6p, GM r90.1): Project home's Delete forever or
 * Empty, or the 30-day expiry, while no Restore project was out. Shown once
 * wherever the project's line showed, with its × only; the kept edits are
 * dropped once it has been seen. Titled as projectDeletedLine.
 * - "Nebula couldn’t keep your change to “Rivers” because its project
 *   “Coast” was deleted for good."
 * - "Nebula couldn’t keep your changes to “Rivers” and “Tide” because their
 *   project “Coast” was deleted for good."
 * - "…your changes to 4 moodboards because their project “Coast” was deleted for good."
 */
export function projectGoneLine(project: string, boards: readonly string[]): { text: string; title: string } {
  const { what, title } = namedBoards([project]);
  const lost = namedBoards(boards.length ? boards : ['']);
  // Each form spelled out whole.
  const text = lost.one ? `Nebula couldn’t keep your change to ${lost.what} because its project ${what} was deleted for good.`
    : `Nebula couldn’t keep your changes to ${lost.what} because their project ${what} was deleted for good.`;
  return { text, title: `${lost.title} in ${title}` };
}

/**
 * The sentence a Restore's confirmation gains when a kept remove didn't
 * replay because the image changed after it (round 6p, GM r90.5): the
 * image stays on the board, and the line says who changed it, by the
 * agent's own label (clipped as a board name is). Numbers follow the names
 * rule ("#3", "#3 and #5"); from four, or across several boards, the count
 * counts them all, and across several boards they're "still on their boards"
 * (round 6q, GM r95.2). With no single known changer, the image is the
 * subject. `by` is the agent's label as the Agent log shows it
 * (keptChangeLabel, round 6q, GM r95.3).
 * - "Claude Code changed #3 after you removed it, so it’s still on the board."
 * - "Claude Code changed #3 and #5 after you removed them, so they’re still on the board."
 * - "Claude Code changed 4 images after you removed them, so they’re still on the board."
 * - "Claude Code changed 2 images after you removed them, so they’re still on their boards." (across boards)
 * - "#3 changed after you removed it, so it’s still on the board."
 */
export function changedAfterRemoveLine(numbers: readonly number[], by: string | null, acrossBoards = false): string {
  if (!numbers.length) return '';
  const one = numbers.length === 1 && !acrossBoards;
  const what = one || (!acrossBoards && numbers.length <= MOST_NAMED) ? joinWithAnd(numbers.map((n) => `#${n}`)) : `${numbers.length} images`;
  const who = by?.trim() ? clipGraphemes(by.trim(), KEPT_NAME_MAX) : '';
  // Each form spelled out whole.
  if (who) {
    if (acrossBoards) return `${who} changed ${what} after you removed them, so they’re still on their boards.`;
    return one ? `${who} changed ${what} after you removed it, so it’s still on the board.`
      : `${who} changed ${what} after you removed them, so they’re still on the board.`;
  }
  if (acrossBoards) return `${what} changed after you removed them, so they’re still on their boards.`;
  return one ? `${what} changed after you removed it, so it’s still on the board.`
    : `${what} changed after you removed them, so they’re still on the board.`;
}

/**
 * The confirmation once Restore project's replayed edits are saved (round
 * 6n, GM r71), naming the project and, as the purged line does, the boards
 * whose kept edit was sent and saved (one; up to three joined; then a
 * count). With none saved (the boards kept every change), the first
 * sentence alone. The title lists every board, then the project, with no
 * colon (GM r74): "“Rivers”, “Tide”, “Harbor” and “Quiet” in “Coast”".
 * - "Restored “Coast”. Your change to “Rivers” is saved."
 * - "Restored “Coast”. Your changes to “Rivers” and “Tide” are saved."
 * - "Restored “Coast”. Your changes to 4 moodboards are saved."
 * - "Restored “Coast”."
 */
export function projectRestoredLine(project: string, saved: readonly string[], stayed = ''): { text: string; title: string } {
  const { what, title } = namedBoards([project]);
  const tail = stayed ? ` ${stayed}` : '';
  if (!saved.length) return { text: `Restored ${what}.${tail}`, title };
  const kept = namedBoards(saved);
  // Each form spelled out whole; a kept remove that didn't replay adds changedAfterRemoveLine's sentence (GM r90.5):
  // "Restored “Coast”. Your change to “Rivers” is saved. Claude changed #3 after you removed it, so it’s still on the board."
  const text = kept.one ? `Restored ${what}. Your change to ${kept.what} is saved.`
    : `Restored ${what}. Your changes to ${kept.what} are saved.`;
  return { text: `${text}${tail}`, title: `${kept.title} in ${title}` };
}

/** Why a Restore project failed (round 6m, GM r53 Q1): the server isn't answering, the project was deleted for good,
 *  or anything else. A project another tab restored first isn't a failure. */
export type ProjectRestoreFailure = 'noAnswer' | 'lost' | 'purged' | 'refused';

/** Which failure a Restore project's error is, from its kind and status, never its words (a 404 is decided by a
 *  look at the project list, so it isn't one of these). */
export function projectRestoreFailure(error: unknown): Exclude<ProjectRestoreFailure, 'purged' | 'lost'> {
  return isBackendUnreachable(error) ? 'noAnswer' : 'refused';
}

/**
 * The line when Restore project fails (round 6m, GM r53 Q1), in the because
 * form, naming the project:
 * - "Nebula couldn’t restore “Shore” because the server isn’t answering.
 *   Try again." (neutral, with Try again);
 * - "Nebula couldn’t restore “Shore” because it was deleted for good. Your
 *   change to “Rivers” can’t be kept." (red, with ×; "Your changes to
 *   “Rivers” and “Harbor”" or "to 4 moodboards" for several);
 * - "Nebula couldn’t restore “Shore” because the server didn’t accept the
 *   request. Try again." (neutral, with Try again);
 * - "Nebula couldn’t restore “Coast” because it lost the connection. Try
 *   again." (round 6p, GM r90.3: the connection dropped mid-request;
 *   neutral, with Try again, which waits for the reconnect).
 * The purged line's title lists every board, then the project, with no colon
 * (GM r74): "“Rivers” and “Harbor” in “Shore”"; the other two name the project.
 */
export function projectRestoreFailedLine(project: string, failure: ProjectRestoreFailure, boards: readonly string[] = []):
  { text: string; title: string } {
  const { what, title } = namedBoards([project]);
  // Each form spelled out whole.
  if (failure === 'noAnswer') return { text: `Nebula couldn’t restore ${what} because the server isn’t answering. Try again.`, title };
  if (failure === 'refused') return { text: `Nebula couldn’t restore ${what} because the server didn’t accept the request. Try again.`, title };
  // Round 6p (GM r90.3): the connection dropped while the request was out (Nebula is offline once a probe answers).
  if (failure === 'lost') return { text: `Nebula couldn’t restore ${what} because it lost the connection. Try again.`, title };
  const lost = namedBoards(boards.length ? boards : ['']);
  const text = lost.one ? `Nebula couldn’t restore ${what} because it was deleted for good. Your change to ${lost.what} can’t be kept.`
    : `Nebula couldn’t restore ${what} because it was deleted for good. Your changes to ${lost.what} can’t be kept.`;
  return { text, title: `${lost.title} in ${title}` };
}

/** A kept Undo that was dropped because the board changed after it (round 6l, GM r21 Q1): neutral, no button. */
export const UNDO_DROPPED_LINE = 'Nebula couldn’t apply your Undo because the board changed after it.';

/**
 * The sentence a Delete forever or Empty confirm gains when boards in it
 * hold kept edits (round 6l, GM r21 Q2), or null when none does:
 * "Your unsaved change to “Rivers” will be lost too."; "Your unsaved changes
 * to “Rivers” and “Harbor” will be lost too."; "Your unsaved changes to 4
 * moodboards will be lost too."
 */
export function lostTooLine(names: readonly string[]): { text: string; title: string } | null {
  if (!names.length) return null;
  const { one, what, title } = namedBoards(names);
  return { text: one ? `Your unsaved change to ${what} will be lost too.` : `Your unsaved changes to ${what} will be lost too.`, title };
}

/** Boards by name for a line: up to MOST_NAMED, each quoted and clipped past KEPT_NAME_MAX, joined with "and", then a count; the title holds every full name.
 *  The count says "moodboards" in every line (round 6q, GM r95.5; PR #228's word): "4 moodboards", never "4 boards"
 *  (tests/lib/errorCopy.namedLine.test.ts's ratchet fails a person line that counts "boards"). */
function namedBoards(names: readonly string[]): { one: boolean; what: string; title: string } {
  const shown = names.map((name) => name.trim() || 'Untitled');
  const what = shown.length <= MOST_NAMED ? joinWithAnd(shown.map((name) => `“${clipGraphemes(name, KEPT_NAME_MAX)}”`)) : `${shown.length} moodboards`;
  return { one: shown.length === 1, what, title: joinWithAnd(shown.map((name) => `“${name}”`)) };
}

/** The most characters (grapheme clusters) of a kept name the line shows before its ellipsis (GM r17 addendum). */
export const KEPT_NAME_MAX = 40;

/** An image a "Kept …" line names (round 6m, GM r53): by the label the board shows for every image, its
 *  number on the board ("Reference #3", as the side panel and each card's name say). Never its private note:
 *  that is the person's own text, and a status line can end up in a screen share or a demo. */
export type KeptImage = { n: number };

/**
 * The neutral line when the board kept its own later change over a draft
 * edit (a repeated create, round 6g; a kept edit replayed after a reload,
 * round 6i), or null when nothing was dropped. One field: only the name
 * shows the value that won, clipped past KEPT_NAME_MAX with the full name in
 * the title ("Kept the name “Rivers” from the board."); every other field,
 * free text included, never shows a value ("Kept the notes from the
 * board."). Several fields go without values, joined with "and" ("Kept the
 * name and notes from the board."), and from four a count ("Kept 4 changes
 * from the board."). GM r16, r17.
 *
 * Round 6l (GM r21 Q1): a kept image change the board changed later is named
 * per image, one item each. Round 6m (GM r53): by the label the person sees,
 * "the changes to Reference #3", never the private note, so no clip and no
 * title for it. With images, each item takes its own "the" ("Kept the name
 * “Tide” and the changes to Reference #3 from the board."); the cover is a
 * board field ("the cover"). From four items, the count.
 */
export function keptFromBoardLine(fields: readonly string[], board: { name?: string } = {}, images: readonly KeptImage[] = []): StudioNotice | null {
  const count = fields.length + images.length;
  if (!count) return null;
  if (count > MOST_NAMED) return `Kept ${count} changes from the board.`;
  const name = (board.name ?? '').trim();
  const showName = fields.length === 1 && fields[0] === 'name' && Boolean(name);
  const clip = (text: string) => clipGraphemes(text, KEPT_NAME_MAX);
  if (!images.length) {
    if (showName) return { text: `Kept the name “${clip(name)}” from the board.`, title: name };
    return `Kept the ${joinWithAnd(fields.map((field) => KEPT_FIELD_NAMES[field] ?? field))} from the board.`;
  }
  const items = [
    ...(showName ? [`the name “${clip(name)}”`] : fields.map((field) => `the ${KEPT_FIELD_NAMES[field] ?? field}`)),
    ...images.map((image) => `the changes to Reference #${image.n}`),
  ];
  const text = `Kept ${joinWithAnd(items)} from the board.`;
  // The name keeps its title (it may be clipped); an image's label never needs one.
  return showName ? { text, title: name } : text;
}
