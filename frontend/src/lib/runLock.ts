import { nodeNameList } from './errorCopy';

/**
 * Design, PR #198: a control this tab's run holds says what
 * unlocks it, one line each, by the control's own verb: "You can … when the
 * run finishes." This table is the one place those verbs live, so the next
 * lock follows the pattern (lib/canvasLock's `act` takes a `runTitle`, and no
 * longer has a default line of its own).
 *
 * - Context-menu rows (and the Inspector's and the selection toolbar's,
 *   which act the same way): the row's verb plus "it" ("them" for a
 *   selection of several nodes).
 * - Cinema's Generate all, a model node's next step, Run history's Forget,
 *   Auto-layout, Load, Import and Clear: The design's words.
 * - Save, Run history's Clear, Arrange (the selection's), Undo and Redo:
 *   on the design's pattern, confirmed in PR #205.
 * The waits other than the run (an import, preparation, a grade, Cinema's
 * other run and running shots) are LOCK_WAITS below, the same sentence.
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
  /** Cinema's toolbar "Generate all" (design PR #205). */
  generateShots: 'generate the shots',
  forgetRun: 'forget this run',
  arrangeCanvas: 'arrange the canvas',
  loadCanvas: 'load a canvas',
  importCanvas: 'import a canvas',
  clearCanvas: 'clear the canvas',
  saveCanvas: 'save the canvas',
  clearRunHistory: 'clear the run history',
  undo: 'undo',
  redo: 'redo',
  /** Cmd+V during a run (design PR #205). */
  paste: 'paste',
  /** The command palette's rows and the toolbar's Run (design, PR #205:
   * one name everywhere). */
  runCanvas: 'run the canvas',
  /** Cinema's "Send to motion" during an import (design PR #205). */
  sendToMotion: 'send it to motion',
  viewVideoNode: 'view the video node',
} as const;
export type RunLockVerb = typeof RUN_LOCK_VERBS[keyof typeof RUN_LOCK_VERBS];

/**
 * Design, PR #205: every lock reason says what unlocks it, in one
 * pattern, "You can <verb> <when>.", with the control's own verb (or, for a
 * thrown refusal with no single control, the refused action). These are the
 * waits a control can name; `lockLine` is the one place the sentence is
 * built.
 */
export const LOCK_WAITS = {
  /** This tab's run (design). */
  run: 'when the run finishes',
  /** A graph import (design PR #205). */
  import: 'when the import finishes',
  /** Generation preparation (Create's launch; design PR #205). */
  preparing: 'when Nebula finishes preparing the run',
  /** Commons: a grade still being written (design PR #205). */
  grade: 'when the grade finishes',
  /** Cinema: another run holds the shot's shared inputs (design PR #205). */
  otherRun: 'when the other run finishes or after you stop it',
  /** Cinema: the scenes' shots still rendering (design PR #205, after). */
  runningShots: 'when the running shots finish',
} as const;
export type LockWait = keyof typeof LOCK_WAITS;

/** "You can <verb> <when>.": a wait from the table, or a named thing still
 * running ("when “Shot 2” finishes", design PR #205 after). */
export function lockLine(verb: string, wait: LockWait | { finishes: string }): string {
  const when = typeof wait === 'string' ? LOCK_WAITS[wait] : `when ${wait.finishes} finishes`;
  return `You can ${verb} ${when}.`;
}

/** The connected add's line, said by the store's refusal and shown in the
 * connection-drop picker alike (design PR #205): "You can add “X”
 * when the import finishes." */
export function addNodeLine(displayName: string, wait: LockWait): string {
  return lockLine(`add “${displayName}”`, wait);
}

/** Design: "You can rerun it when the run finishes." Any verb: Run history's
 * replays pass their offline verbs ("rerun it", "retry it", "recover it"). */
export function runFinishesLine(verb: string): string {
  return lockLine(verb, 'run');
}

/** The canvas actions panel's one line over its Graph group while a run
 * holds it (Save, Load, Import and Clear each say their own verb too). The
 * builder's, on the design's pattern, for the designer to confirm. */
export const FILES_VERB = 'save, load, import or clear the canvas';
export const RUN_LOCKED_FILES_LINE = runFinishesLine(FILES_VERB);

/** "it" for one node, "them" for several: a selection's own verb. */
export function itOrThem(count: number, one: RunLockVerb, several: RunLockVerb): RunLockVerb {
  return count > 1 ? several : one;
}

/**
 * Design, PR #198: the deferred run notice is a state line, read
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

/** What the canvas waits for now, as the toolbar's files group reads it:
 * this tab's run (or its start), then Create's launch, then an import. */
export interface CanvasWaitState {
  isExecuting: boolean;
  runStarting?: boolean;
  isImportingGraph: boolean;
  createLaunchingIds: readonly string[];
}
export function canvasWait(state: CanvasWaitState): LockWait | null {
  if (state.isExecuting || state.runStarting) return 'run';
  if (state.createLaunchingIds.length > 0) return 'preparing';
  if (state.isImportingGraph) return 'import';
  return null;
}

/** Design, PR #205: the line a canvas command locked by a
 * wait says, from the same table wherever it shows (a palette row's own
 * text, or the key press's place): "You can save the canvas when the
 * import finishes." Null when nothing waits. */
export function canvasWaitLine(verb: string, state: CanvasWaitState): string | null {
  const wait = canvasWait(state);
  return wait ? lockLine(verb, wait) : null;
}
