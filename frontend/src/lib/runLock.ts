import { nodeNameList } from './errorCopy';

/**
 * GM, PR #198 r37 and r39 item 2: a control this tab's run holds says what
 * unlocks it, one line each, by the control's own verb: "You can … when the
 * run finishes." This table is the one place those verbs live, so the next
 * lock follows the pattern (lib/canvasLock's `act` takes a `runTitle`, and no
 * longer has a default line of its own).
 *
 * - Context-menu rows (and the Inspector's and the selection toolbar's,
 *   which act the same way): the row's verb plus "it" ("them" for a
 *   selection of several nodes).
 * - Cinema's Generate, a model node's next step, Run history's Forget,
 *   Auto-layout, Load, Import and Clear: GM's words.
 * - The rest are the builder's, on GM's pattern, for GM to confirm: Save,
 *   Run history's Clear, Arrange (the selection's), Undo and Redo, and the
 *   add-a-node refusal.
 */
export const RUN_LOCK_VERBS = {
  runIt: 'run it',
  runThem: 'run them',
  duplicateIt: 'duplicate it',
  duplicateThem: 'duplicate them',
  deleteIt: 'delete it',
  deleteThem: 'delete them',
  arrangeThem: 'arrange them',
  generateShot: 'generate this shot',
  forgetRun: 'forget this run',
  arrangeCanvas: 'arrange the canvas',
  loadCanvas: 'load a canvas',
  importCanvas: 'import a canvas',
  clearCanvas: 'clear the canvas',
  saveCanvas: 'save the canvas',
  clearRunHistory: 'clear the run history',
  addIt: 'add it',
  undo: 'undo',
  redo: 'redo',
} as const;
export type RunLockVerb = typeof RUN_LOCK_VERBS[keyof typeof RUN_LOCK_VERBS];

/** GM r37: "You can rerun it when the run finishes." Any verb: Run history's
 * replays pass their offline verbs ("rerun it", "retry it", "recover it"). */
export function runFinishesLine(verb: string): string {
  return `You can ${verb} when the run finishes.`;
}

/** The canvas actions panel's one line over its Graph group while a run
 * holds it (Save, Load, Import and Clear each say their own verb too). The
 * builder's, on GM's pattern, for GM to confirm. */
export const RUN_LOCKED_FILES_LINE = runFinishesLine('save, load, import or clear the canvas');

/** "it" for one node, "them" for several: a selection's own verb. */
export function itOrThem(count: number, one: RunLockVerb, several: RunLockVerb): RunLockVerb {
  return count > 1 ? several : one;
}

/**
 * GM, PR #198 r40 item 3: the deferred run notice is a state line, read
 * live. While a run goes: "You can run “X” when the current run finishes.";
 * once it has finished: "You can run “X” now." The held nodes are named by
 * the shared name-list rule (their card titles); "it" only when none of them
 * has a name.
 */
export function deferredRunLine(names: readonly string[], running: boolean): string {
  const named = names.filter((name) => name.trim().length > 0);
  const what = named.length > 0 ? nodeNameList([...named]) : 'it';
  return running ? `You can run ${what} when the current run finishes.` : `You can run ${what} now.`;
}
