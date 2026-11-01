import type { ReactFlowState } from '@xyflow/react';

/**
 * A stand-in for React Flow's store in tests that mock `@xyflow/react`.
 *
 * The real `useStore(selector)` runs the selector against the store's state,
 * and components rely on what comes back: a zoom number, a `nodes` array, a
 * string key they `.split` (AgentNodeMarkLayer, AgentNoteOutlineLayer). A
 * mock that answers every call with one constant (`useStore: () => 1`) hands
 * those components a number where they expect a string, and the deferred
 * layers crash when their chunk lands ("key.split is not a function"), which
 * React logs under whichever test is running at that moment.
 *
 * This keeps one small state per mocked module with the fields the canvas
 * and its layers read: an empty flow, 1280x800, zoom 1. `useStore` runs the
 * selector against it, and `useStoreApi` returns the same state, so
 * `getState` and `setState` agree with what the selectors see.
 */
export function fakeFlowState(overrides: Partial<ReactFlowState> = {}): ReactFlowState {
  return {
    width: 1280,
    height: 800,
    minZoom: 0.1,
    maxZoom: 2,
    transform: [0, 0, 1],
    nodes: [],
    edges: [],
    nodeLookup: new Map(),
    parentLookup: new Map(),
    edgeLookup: new Map(),
    connectionLookup: new Map(),
    nodesSelectionActive: false,
    userSelectionActive: false,
    multiSelectionActive: false,
    paneDragging: false,
    panZoom: null,
    domNode: null,
    ...overrides,
  } as unknown as ReactFlowState;
}

export interface FakeFlowStore {
  readonly state: ReactFlowState;
  /** React Flow's `useStore`: the selector's answer for the fake state. */
  readonly useStore: <T>(selector: (state: ReactFlowState) => T) => T;
  /** React Flow's `useStoreApi`: read and write the same fake state. */
  readonly useStoreApi: () => {
    getState: () => ReactFlowState;
    setState: (partial: Partial<ReactFlowState> | ((state: ReactFlowState) => Partial<ReactFlowState>)) => void;
    subscribe: () => () => void;
  };
}

export function fakeFlowStore(overrides: Partial<ReactFlowState> = {}): FakeFlowStore {
  const state = fakeFlowState(overrides);
  const api = {
    getState: () => state,
    setState: (partial: Partial<ReactFlowState> | ((current: ReactFlowState) => Partial<ReactFlowState>)) => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial);
    },
    subscribe: () => () => {},
  };
  return {
    state,
    useStore: (selector) => selector(state),
    useStoreApi: () => api,
  };
}

/**
 * Bring in the canvas layers that read React Flow's store through a selector,
 * as App does on idle, so they draw in every test against the fake store
 * instead of whenever their chunk happens to land (often mid-test, where a
 * failure is logged under an unrelated test, or not at all).
 */
export async function preloadFlowLayers(): Promise<void> {
  const { DeferredAgentNodeMarkLayer, DeferredAgentNoteOutlineLayer } = await import('../../src/lib/deferredChunks');
  await Promise.all([DeferredAgentNodeMarkLayer.preload(), DeferredAgentNoteOutlineLayer.preload()]);
}
