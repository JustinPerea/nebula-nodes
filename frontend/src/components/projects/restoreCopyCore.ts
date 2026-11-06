import { tabWord } from '../../lib/tabWord';

/**
 * The restore lines the entry chunk needs (review 13 of PR #199, LOW-1):
 * the store's and the kept line's. Everything else of catalogRestoreCopy
 * loads only when a restore notice shows (restoreCopyLoader).
 */

export const quoted = (name: string) => `“${name}”`;

/** The backend's MAX_PROJECTS, for a listing that doesn't say it. */
export const DEFAULT_PROJECT_LIMIT = 500;

/** GM r12 on PR #199, 1: the button beside the line a restore leaves when
 * this tab's edits weren't saved (projectStore RESTORED_LIST_UNSAVED). */
export const SAVE_AS_A_PROJECT = 'Save as a project';

/** Its saved toast names the project the edits went into, under its
 * recovered name, "Recovered <project>" (GM r14 on PR #199, 1, verbatim;
 * the name's shape is GM r23, a). */
export function editsRecoveredToast(name: string): string {
  return `Your latest edits were saved as their own project, ${quoted(name)}.`;
}

/** GM r14, 3 (and r12, 1): the second half of a kept-in-this-tab line, for
 * edits a closed project never got. */
export const LATEST_EDITS_KEPT = `Your latest edits weren’t saved yet. They’re kept in this ${tabWord()}.`;
/** GM r14, 3: added where the tab can't go home by itself. */
export const RELOAD_TO_CONTINUE = 'Reload projects to continue.';

/** GM r14 on PR #199, 3, verbatim: the agent and what it did to the
 * person's canvas when its write closed the project the tab showed ("An
 * agent" when unknown). `name` is that project's: it was kept, untouched.
 * The same words are the person's Agent log row for a canvas that already
 * was a project (GM r15). */
export function agentClosedLine(agent: string | null | undefined, action: 'clear' | 'replace' | 'change', name: string): string {
  const who = agent && agent.trim() ? agent.trim() : 'An agent';
  if (action === 'clear') return `${who} cleared the canvas. ${quoted(name)} is kept as its own project.`;
  if (action === 'replace') return `${who} replaced the canvas. ${quoted(name)} is kept as its own project.`;
  return `${who} made its changes on a copy of ${quoted(name)}. ${quoted(name)} is kept as it was.`;
}

/** GM r5, the size cap's advice by whether Recently deleted has items. In the
 * entry chunk: the kept save's refusal for the storage cap says it too
 * (GM r23 on PR #199, 3), and the restore notices' lines share it. */
export function sizeCapAdvice(trashHasItems: boolean): string {
  return trashHasItems
    ? 'Permanently delete a project in Recently deleted and Nebula will save it.'
    : 'Delete a project, then remove it from Recently deleted too, and Nebula will save it.';
}

/** The head all three kept-save refusals share (GM r24 (b): "make the three
 * kept-save refusals match", and no second "Nebula"). */
const KEPT_SAVE_REFUSED = 'Nebula couldn’t save your edits as a project because';

/** GM r23 on PR #199, 3; GM r24 (b), verbatim: the kept save the storage cap
 * refused. The edits stay kept (they are the only copy), and this line says
 * why and what makes room. */
export function keptStorageFullLine(): string {
  return `${KEPT_SAVE_REFUSED} the project list is full. Delete a project and remove it from Recently deleted, and Nebula saves your edits.`;
}

/** GM r24 (b), verbatim: the kept save the project limit refused. At the
 * limit, "…because you’ve reached the limit of 3 projects. Delete 1 project, and
 * Nebula saves your edits."; over it, "…because you have 2 projects, over the
 * limit of 1. Delete 2 projects, and Nebula saves your edits." `deletes` is what the
 * backend counted, else the count past the limit plus one. */
export function keptLimitLine(count: number, limit: number, deletes?: number | null): string {
  const n = Math.max(1, typeof deletes === 'number' && Number.isInteger(deletes) && deletes > 0 ? deletes : count - limit + 1);
  const why = count > limit
    ? `you have ${count} ${count === 1 ? 'project' : 'projects'}, over the limit of ${limit}`
    : `you’ve reached the limit of ${limit} ${limit === 1 ? 'project' : 'projects'}`;
  return `${KEPT_SAVE_REFUSED} ${why}. Delete ${n} ${n === 1 ? 'project' : 'projects'}, and Nebula saves your edits.`;
}

/** PR #199 r26 (for GM): the notice's line once deleting has made room, until the retry
 * starts or while a run or offline holds it. */
export const KEPT_ROOM_LINE = 'There’s room now. Nebula is saving your edits as a project.';

/** PR #199 r27 (for GM): the notice's line while a Delete that made room still shows its Undo:
 * the save waits for the toast to go (or for [Save as a project]), so Undo is real. */
export const KEPT_ROOM_WAIT_LINE = 'There’s room now. Nebula will save your edits as a project when Undo goes away.';

/** PR #199 r27 (for GM): why the project the kept edits came from can't be deleted from here, in the
 * chooser's row and after the heading of the refusal Delete gives. */
export const KEPT_SOURCE_DELETE_LINE = 'Your kept edits came from this project. You can delete it after you save them as a project or discard them.';

/** GM r24 (b): the button that opens the chooser on either of those two
 * notices. Kept mode locks Projects, so deleting has nowhere to happen without it. */
export const CHOOSE_A_PROJECT_TO_DELETE = 'Choose a project to delete';

/** The button the notice shows when something is in Recently deleted. */
export const OPEN_RECENTLY_DELETED = 'Open Recently deleted';

/** The restore notice's line when the rest of its copy couldn't load
 * (review 14 of PR #199, lock-order LOW-3): never a blank notice. The first
 * sentence of GM's RESTORED_LIST_RELOAD, true of every restore. */
export const RESTORE_COPY_FALLBACK = 'Nebula restored its project list.';

/** GM r23 on PR #199, 3, verbatim: the fallback while this tab keeps edits
 * that weren't saved. The short line drops the one fact that matters, so
 * the full sentence stays, and it never suggests reloading (a reload would
 * lose the edits). It lives here, in the entry chunk, so it never depends
 * on the chunk whose load failed (scripts/check-kept-guard-chunk.mjs). The
 * same words as projectStore's RESTORED_LIST_UNSAVED. */
export const RESTORE_COPY_FALLBACK_KEPT = `Nebula restored its project list before your latest edits were saved. They’re kept in this ${tabWord()}.`;

/** The fallback line for the notice: the full sentence while kept. */
export function restoreCopyFallback(kept: boolean): string {
  return kept ? RESTORE_COPY_FALLBACK_KEPT : RESTORE_COPY_FALLBACK;
}

/** A notice that confirms Save as a project's copy ("Your latest edits were
 * saved…", the after-update line), then the line for any connection its
 * rules left out (GM r24: the second sentence, on every ending). */
export function filedCopyLine(lead: string, copy: { dropped?: string }): string {
  return copy.dropped ? `${lead} ${copy.dropped}` : lead;
}
