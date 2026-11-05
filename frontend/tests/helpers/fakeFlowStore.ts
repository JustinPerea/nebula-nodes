import { afterEach, beforeAll, beforeEach } from 'vitest';
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
 * `fakeFlow` holds one small state with the fields the canvas and its layers
 * read: an empty flow, 1280x800, zoom 1. `useStore` runs the selector against
 * it, and `useStoreApi` reads and writes the same state. `installFakeFlowStore()`
 * builds the state fresh before each test, so a `setState` in one test never
 * reaches the next.
 *
 * In a test file: mock `@xyflow/react` with `useStore: fakeFlow.useStore` and
 * `useStoreApi: fakeFlow.useStoreApi` (import this module inside the mock
 * factory), then call `installFakeFlowStore()` once at the top level.
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

type StatePatch = Partial<ReactFlowState> | ((state: ReactFlowState) => Partial<ReactFlowState>);

let current = fakeFlowState();

const api = {
  getState: (): ReactFlowState => current,
  setState: (patch: StatePatch): void => {
    current = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
  },
  subscribe: (): (() => void) => () => {},
};

export const fakeFlow = {
  /** The state selectors see now. */
  get state(): ReactFlowState {
    return current;
  },
  /** A fresh state (with `overrides`); `installFakeFlowStore()` calls it before each test. */
  reset(overrides: Partial<ReactFlowState> = {}): void {
    current = fakeFlowState(overrides);
  },
  /** React Flow's `useStore`: the selector's answer for the fake state. */
  useStore<T>(selector: (state: ReactFlowState) => T): T {
    return selector(current);
  },
  /** React Flow's `useStoreApi`: read and write the same fake state. */
  useStoreApi: () => api,
};

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

/**
 * What a layer that crashed on the store's answer logs. DeferredBoundary
 * catches the throw, so the test itself would stay green; the guard below
 * turns the log into a failure.
 */
const LAYER_CRASH = /\.split is not a function|A deferred part of the app failed while drawing/;

/** Layer crashes logged during the current test, and whether it prints them. */
const crashes: string[] = [];
let quiet = false;

/**
 * For a test that keeps the console quiet (in place of
 * `vi.spyOn(console, 'error').mockImplementation(() => {})`): nothing prints
 * for the rest of the test, but a layer crash still fails it. A spy over the
 * console would hide the crash from `installFakeFlowStore()`'s guard.
 */
export function quietConsole(): void {
  quiet = true;
}

/**
 * For a test file whose `@xyflow/react` mock uses `fakeFlow`: preload the
 * store-reading layers, build the state fresh before each test, and fail a
 * test in which a layer crashed while drawing (console.error from React,
 * console.warn from DeferredBoundary). Messages still print as before.
 */
export function installFakeFlowStore(): void {
  const original = { error: console.error, warn: console.warn };
  const watch = (method: 'error' | 'warn') => (...args: unknown[]) => {
    const text = args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' ');
    const line = text.split('\n').find((part) => LAYER_CRASH.test(part));
    if (line) crashes.push(line.trim());
    if (!quiet) original[method](...args);
  };
  beforeAll(preloadFlowLayers);
  beforeEach(() => {
    fakeFlow.reset();
    crashes.length = 0;
    quiet = false;
    console.error = watch('error');
    console.warn = watch('warn');
  });
  afterEach(() => {
    console.error = original.error;
    console.warn = original.warn;
    quiet = false;
    if (crashes.length > 0) {
      const lines = [...new Set(crashes)];
      crashes.length = 0;
      throw new Error(`A canvas layer crashed while drawing (check the @xyflow/react mock's useStore):\n  ${lines.join('\n  ')}`);
    }
  });
}
