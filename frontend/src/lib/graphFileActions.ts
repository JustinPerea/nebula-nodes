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
