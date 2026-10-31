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
