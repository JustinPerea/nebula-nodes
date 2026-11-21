import { tabWord } from '../../lib/tabWord';

/**
 * The restore lines the entry chunk needs (PR #199): the store's and the
 * kept line's. Everything else of catalogRestoreCopy loads only when a
 * restore notice shows (restoreCopyLoader).
 */

export const quoted = (name: string) => `“${name}”`;

/** The backend's MAX_PROJECTS, for a listing that doesn't say it. */
export const DEFAULT_PROJECT_LIMIT = 500;

/** The button beside the line a restore leaves when this tab's edits weren't
 * saved (design, PR #199; projectStore RESTORED_LIST_UNSAVED). */
export const SAVE_AS_A_PROJECT = 'Save as a project';

/** Its saved toast names the project the edits went into, under its
 * recovered name, "Recovered <project>" (design, PR #199, verbatim; the
 * name's shape is the design's too). */
export function editsRecoveredToast(name: string): string {
  return `Your latest edits were saved as their own project, ${quoted(name)}.`;
}

/** The second half of a kept-in-this-tab line, for edits a closed project
 * never got (design, PR #199). */
export const LATEST_EDITS_KEPT = `Your latest edits weren’t saved yet. They’re kept in this ${tabWord()}.`;
/** Added where the tab can't go home by itself (design, PR #199). */
export const RELOAD_TO_CONTINUE = 'Reload projects to continue.';

/** The agent and what it did to the person's canvas when its write closed the
 * project the tab showed (design, PR #199, verbatim; "An agent" when
 * unknown). `name` is that project's: it was kept, untouched. The same words
 * are the person's Agent log row for a canvas that already was a project. */
export function agentClosedLine(agent: string | null | undefined, action: 'clear' | 'replace' | 'change', name: string): string {
  const who = agent && agent.trim() ? agent.trim() : 'An agent';
  if (action === 'clear') return `${who} cleared the canvas. ${quoted(name)} is kept as its own project.`;
  if (action === 'replace') return `${who} replaced the canvas. ${quoted(name)} is kept as its own project.`;
  return `${who} made its changes on a copy of ${quoted(name)}. ${quoted(name)} is kept as it was.`;
}

/** The size cap's advice by whether Recently deleted has items (design). In
 * the entry chunk: the kept save's refusal for the storage cap says it too
 * (PR #199), and the restore notices' lines share it. */
export function sizeCapAdvice(trashHasItems: boolean): string {
  return trashHasItems
    ? 'Permanently delete a project in Recently deleted and Nebula will save it.'
    : 'Delete a project, then remove it from Recently deleted too, and Nebula will save it.';
}

/** The head all three kept-save refusals share (the design asked that the
 * three match, and no second "Nebula"). */
const KEPT_SAVE_REFUSED = 'Nebula couldn’t save your edits as a project because';

/** The kept save the storage cap refused (design, PR #199, verbatim). The
 * edits stay kept (they are the only copy), and this line says why and what
 * makes room. */
export function keptStorageFullLine(): string {
  return `${KEPT_SAVE_REFUSED} the project list is full. Delete a project and remove it from Recently deleted, and Nebula saves your edits.`;
}

/** The kept save the project limit refused (design, verbatim). At the limit,
 * "…because you’ve reached the limit of 3 projects. Delete one, and Nebula
 * saves your edits." (the design's sign-off, 2026-11-13: "Delete one", not
 * "Delete 1 project"); over it, "…because you have 2 projects, over the limit
 * of 1. Delete 2 projects, and Nebula saves your edits." `deletes` is what the
 * backend counted, else the count past the limit plus one. */
export function keptLimitLine(count: number, limit: number, deletes?: number | null): string {
  const n = Math.max(1, typeof deletes === 'number' && Number.isInteger(deletes) && deletes > 0 ? deletes : count - limit + 1);
  const why = count > limit
    ? `you have ${count} ${count === 1 ? 'project' : 'projects'}, over the limit of ${limit}`
    : `you’ve reached the limit of ${limit} ${limit === 1 ? 'project' : 'projects'}`;
  return `${KEPT_SAVE_REFUSED} ${why}. Delete ${n === 1 ? 'one' : `${n} projects`}, and Nebula saves your edits.`;
}

/** The notice's line once deleting has made room, until the retry starts or
 * while a run or offline holds it (PR #199; wording not yet confirmed by the
 * design). */
export const KEPT_ROOM_LINE = 'There’s room now. Nebula is saving your edits as a project.';

/** The notice's line while a Delete that made room still shows its Undo: the
 * save waits for the toast to go (or for [Save as a project]), so Undo is
 * real (PR #199; wording not yet confirmed by the design). */
export const KEPT_ROOM_WAIT_LINE = 'There’s room now. Nebula will save your edits as a project when Undo goes away.';

/** Why the project the kept edits came from can't be deleted from here, in the
 * chooser's row and after the heading of the refusal Delete gives (PR #199;
 * wording not yet confirmed by the design). */
export const KEPT_SOURCE_DELETE_LINE = 'Your kept edits came from this project. You can delete it after you save them as a project or discard them.';

/** The button that opens the chooser on either of the two refusal notices
 * (keptStorageFullLine, keptLimitLine). Kept mode locks Projects, so deleting
 * has nowhere to happen without it. */
export const CHOOSE_A_PROJECT_TO_DELETE = 'Choose a project to delete';

/** The button the notice shows when something is in Recently deleted. */
export const OPEN_RECENTLY_DELETED = 'Open Recently deleted';

/** The restore notice's line when the rest of its copy couldn't load (PR #199):
 * never a blank notice. The first sentence of the store's RESTORED_LIST_RELOAD,
 * true of every restore. */
export const RESTORE_COPY_FALLBACK = 'Nebula restored its project list.';

/** The fallback while this tab keeps edits that weren't saved (design, PR #199,
 * verbatim). The short line drops the one fact that matters, so the full
 * sentence stays, and it never suggests reloading (a reload would lose the
 * edits). It lives here, in the entry chunk, so it never depends on the chunk
 * whose load failed (scripts/check-kept-guard-chunk.mjs). The same words as
 * projectStore's RESTORED_LIST_UNSAVED. */
export const RESTORE_COPY_FALLBACK_KEPT = `Nebula restored its project list before your latest edits were saved. They’re kept in this ${tabWord()}.`;

/** The fallback line for the notice: the full sentence while kept. */
export function restoreCopyFallback(kept: boolean): string {
  return kept ? RESTORE_COPY_FALLBACK_KEPT : RESTORE_COPY_FALLBACK;
}

/** A notice that confirms Save as a project's copy ("Your latest edits were
 * saved…", the after-update line), then the line for any connection its
 * rules left out (the second sentence, on every ending; design). */
export function filedCopyLine(lead: string, copy: { dropped?: string }): string {
  return copy.dropped ? `${lead} ${copy.dropped}` : lead;
}
