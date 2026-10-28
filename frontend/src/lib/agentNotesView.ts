import { MAX_NOTE_BUTTONS, type AgentNote, type AgentNoteAbout, type AgentNoteAction, type AgentNoteAuthor } from './agentNotes';

/**
 * How the Updates corner draws an update: header labels, clock time, author
 * dots, the buttons (edit actions first, then Show) and the corner's place
 * beside the chat. Only the deferred corner imports this (lib/agentNotes.ts
 * holds what the startup store needs).
 */

/** The muted header label: Nebula's words, from `about`. Agents never write it. */
export function aboutLabel(about: AgentNoteAbout): string {
  switch (about) {
    case 'sinceLastTurn': return 'since its last turn';
    case 'suggestion': return 'Analyze';
    case 'analyze': return 'Analyze · run done';
    case 'removedLook':
    case 'changedWords': return 'Restore';
    case 'proposal': return 'waiting for your OK';
    // "{agent} has a question." says it already (GM, Q125 item 1).
    case 'question': return '';
    default: return '';
  }
}

/** The header label for this update: none once an asset proposal's Update has resolved. */
export function noteLabel(note: Pick<AgentNote, 'about' | 'resolvedAt'>): string {
  return note.resolvedAt ? '' : aboutLabel(note.about);
}

/**
 * Whether a dismiss greys the update. A question Update's x only drops its
 * card: the Update is the person's one way into an open set (no expiry, no
 * canvas bar), so it greys when the set closes (resolvedAt), not on dismiss.
 */
function dismissGreys(note: Pick<AgentNote, 'about' | 'dismissedAt'>): boolean {
  return Boolean(note.dismissedAt) && note.about !== 'question';
}

/** Whether the update is greyed: dismissed, acted on, or its proposal or question set closed. */
export function noteDone(note: Pick<AgentNote, 'about' | 'dismissedAt' | 'actedAt' | 'resolvedAt'>): boolean {
  return Boolean(dismissGreys(note) || note.actedAt || note.resolvedAt);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12:14" today; "Oct 19, 16:02" on an earlier day (24-hour, as GM's still). */
export function clockTime(at: string, now: Date): string {
  const when = new Date(at);
  if (!at || Number.isNaN(when.getTime())) return '';
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  const sameDay = when.getFullYear() === now.getFullYear()
    && when.getMonth() === now.getMonth()
    && when.getDate() === now.getDate();
  return sameDay ? time : `${MONTHS[when.getMonth()]} ${when.getDate()}, ${time}`;
}

/** A done card's video length in its thumbnail's corner (Q125 item 3): m:ss. */
export function clipDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The dot's label: an agent's initial ("C"), the reader's model name ("Ar" for Argon). */
export function authorInitials(author: Pick<AgentNoteAuthor, 'kind' | 'name'>): string {
  const words = author.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return author.kind === 'reader' ? 'R' : 'A';
  if (author.kind === 'reader') {
    const last = words[words.length - 1];
    return last.slice(0, 1).toUpperCase() + last.slice(1, 2).toLowerCase();
  }
  return words[0].slice(0, 1).toUpperCase();
}

/**
 * The text as the person reads it: board numbers drawn from refs. With
 * `numberFor` (the board open in Moodboard Studio) each number is the
 * image's place now, so a removal since the server drew it can't mislabel it.
 */
export function noteText(note: Pick<AgentNote, 'parts' | 'text'>, numberFor?: (ref: string) => number | null): string {
  return note.parts
    .map((part) => {
      if ('text' in part) return part.text;
      const number = numberFor ? numberFor(part.ref) : part.number;
      return number ? `#${number}` : '(removed)';
    })
    .join('');
}

export interface ShowContext {
  surface: 'canvas' | 'board';
  /** A board image's current number, or null once it is gone. */
  numberFor?: (ref: string) => number | null;
}

/** "Show #37" for one board image, "Show on board" for more; "Show on canvas" on the main canvas. */
export function showLabel(note: Pick<AgentNote, 'refs'>, context: ShowContext): string {
  if (context.surface === 'canvas') return 'Show on canvas';
  if (note.refs.length === 1) {
    const number = context.numberFor?.(note.refs[0]) ?? null;
    if (number) return `Show #${number}`;
  }
  return 'Show on board';
}

export type NoteButton =
  | { kind: 'action'; label: string; action: AgentNoteAction; primary: boolean }
  | { kind: 'show'; label: string };

export interface NoteControls {
  buttons: NoteButton[];
  /** Why the edit actions are gone ("Not now", "Undone", "Expired"), else null. */
  state: string | null;
}

const ACTED_STATE: Record<string, string> = {
  'Make frame': 'Frame made',
  'Add copies': 'Copies added',
  'Undo the move': 'Undone',
  'Undo the sort': 'Undone',
  Restore: 'Restored',
  Accept: 'Accepted',
  Reject: 'Rejected',
  'Not now': 'Not now',
};

const PRIMARY_KINDS = new Set(['suggestion.accept', 'proposal.accept']);

/** What a greyed update says in place of its edit actions, or null while they stand. */
export function stateLabel(note: AgentNote, actionState?: (action: AgentNoteAction) => string | null): string | null {
  // An asset proposal's Update: how the proposal ended, in place of Review.
  if (note.outcome) return note.outcome;
  if (note.resolvedAt) return 'Done';
  if (note.actedAt) return (note.actedWith && ACTED_STATE[note.actedWith]) || 'Done';
  if (dismissGreys(note)) return 'Not now';
  if (actionState) {
    for (const action of note.actions) {
      const stale = actionState(action);
      if (stale) return stale;
    }
  }
  return null;
}

/** Edit actions first, then Show when a slot is left: two buttons at most. */
export function noteControls(
  note: AgentNote,
  options: { showLabel: string; actionState?: (action: AgentNoteAction) => string | null },
): NoteControls {
  const state = note.actions.length > 0 || noteDone(note)
    ? stateLabel(note, options.actionState)
    : null;
  const buttons: NoteButton[] = [];
  if (!state) {
    for (const action of note.actions.slice(0, MAX_NOTE_BUTTONS)) {
      buttons.push({ kind: 'action', label: action.label, action, primary: PRIMARY_KINDS.has(action.op.kind) });
    }
  }
  if (note.refs.length > 0 && buttons.length < MAX_NOTE_BUTTONS) buttons.push({ kind: 'show', label: options.showLabel });
  return { buttons, state };
}

/** The question set an Update asks (Q125 item 1), or null for any other update. */
export function questionSetId(note: Pick<AgentNote, 'about' | 'actions' | 'questionsId'>): string | null {
  if (note.about !== 'question') return null;
  if (note.questionsId) return note.questionsId;
  const op = note.actions.find((action) => action.op.kind === 'question.answer')?.op;
  return op && typeof op.questionId === 'string' && op.questionId ? op.questionId : null;
}

/** Whether the update still offers "Not now" (the list's footer explains it). */
export function offersNotNow(note: AgentNote): boolean {
  return !note.dismissedAt && !note.actedAt && note.actions.some((action) => action.op.kind === 'suggestion.dismiss');
}

export interface Box { left: number; right: number; top: number; bottom: number }

/**
 * The corner's `right` offset in px: the gutter, or just left of the chat
 * panel when the chat's rect would meet the box (docked tall, or dragged up
 * to the corner). Never pushed past the left edge.
 */
export function cornerRight(
  chat: Box | null,
  viewport: { width: number; height: number },
  box: { top: number; height: number; width: number },
  gutter: number,
  gap = 8,
): number {
  if (!chat) return gutter;
  const left = viewport.width - gutter - box.width;
  const right = viewport.width - gutter;
  const meetsVertically = chat.top < box.top + box.height && chat.bottom > box.top;
  const meetsHorizontally = chat.left < right && chat.right > left;
  if (!meetsVertically || !meetsHorizontally) return gutter;
  const beside = viewport.width - chat.left + gap;
  return Math.max(gutter, Math.min(beside, viewport.width - box.width - gutter));
}

/**
 * How tall the card or the list may grow from `box.top`: down to the nearest
 * thing below it that shares its columns (the proposal bar, the Agent log,
 * the chat launcher, the toolbar), less a gap; else to the window's foot.
 */
export function roomBelow(
  box: { left: number; right: number; top: number },
  obstacles: Box[],
  viewportHeight: number,
  gap: number,
): number {
  let limit = viewportHeight - gap;
  for (const obstacle of obstacles) {
    if (obstacle.right <= box.left || obstacle.left >= box.right) continue;
    if (obstacle.top <= box.top) continue;
    limit = Math.min(limit, obstacle.top - gap);
  }
  return limit - box.top;
}
