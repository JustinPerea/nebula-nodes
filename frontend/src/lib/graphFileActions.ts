import { RUN_LOCK_VERBS, canvasWaitLine } from './runLock';

/** One app-level controller owns file actions in every workspace. */
export const GRAPH_SAVE_EVENT = 'nebula:save';
export const GRAPH_LOAD_EVENT = 'nebula:load';

interface GraphFileActionState {
  isExecuting: boolean;
  isImportingGraph: boolean;
  createLaunchingIds: readonly string[];
  providerStartAmbiguities: readonly unknown[];
}

export function canLoadGraph(state: GraphFileActionState): boolean {
  return !state.isImportingGraph && !state.isExecuting && state.createLaunchingIds.length === 0;
}

export function canSaveGraph(state: GraphFileActionState): boolean {
  return canLoadGraph(state) && state.providerStartAmbiguities.length === 0;
}

export function requestGraphSave(): void {
  window.dispatchEvent(new CustomEvent(GRAPH_SAVE_EVENT));
}

export function requestGraphLoad(): void {
  window.dispatchEvent(new CustomEvent(GRAPH_LOAD_EVENT));
}

/** GM PR #205 r4 item 4: Cmd+S or Cmd+O pressed while a wait holds the
 * files (this tab's run, Create's launch, an import) says the palette's
 * line for it, in the key presses' place: "You can save the canvas when
 * the run finishes.", "You can load a canvas when the run finishes." Null
 * when no wait holds it (a refusal of another kind keeps its own way). */
export function fileKeyLockLine(key: 's' | 'o', state: GraphFileActionState): string | null {
  if (key === 's' ? canSaveGraph(state) : canLoadGraph(state)) return null;
  return canvasWaitLine(key === 's' ? RUN_LOCK_VERBS.saveCanvas : RUN_LOCK_VERBS.loadCanvas, state);
}
