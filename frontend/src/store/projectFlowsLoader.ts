import { deferredModule, type DeferredModule } from '../lib/lazyWithPreload';

/**
 * PR #199 round 25: the project store's flows (store/projectFlows.ts: opening,
 * making, switching, releasing and saving a project, and every line they
 * say) load as one chunk instead of with the entry, which stays under its
 * budget. The store's state, its API shape and its autosave hot path stay in
 * store/projectStore.ts; each flow is a thin stub there that runs the chunk's
 * function (at once when it is in, after it loads when it isn't).
 *
 * Started in main.tsx before the first render so the fetch overlaps it, and
 * preloaded with the other deferred chunks (lib/deferredChunks.ts).
 * `flowsNow()` is null until it is in. A project context exists only once the
 * chunk is evaluated (projectFlows is the only place that sets one), so code
 * that runs only with a context may call `flowsNow()!`.
 *
 * Nothing but tests imports store/projectFlows.ts directly (a second
 * instance loaded from a fresh retry URL would split its state in two;
 * tests/projectFlowsRules.test.ts).
 */
export type ProjectFlows = typeof import('./projectFlows');

let importFlows = (): Promise<ProjectFlows> => import('./projectFlows');
let chunk: DeferredModule<ProjectFlows> = deferredModule(() => importFlows());
let loaded: ProjectFlows | null = null;
const remember = (module: ProjectFlows): ProjectFlows => { loaded = module; return module; };

export const projectFlowsModule: DeferredModule<ProjectFlows> = {
  load: () => (loaded ? Promise.resolve(loaded) : chunk.load().then(remember)),
  preload: () => projectFlowsModule.load(),
  isLoaded: () => loaded !== null,
};

/** The flows now, or null while the chunk loads. */
export function flowsNow(): ProjectFlows | null {
  return loaded;
}

// Tests read the flows at once, as if loaded (a press is synchronous once the
// chunk is warm): tests/setup.ts primes them before each test, through this,
// only in a file whose graph holds the store (a file that never loads it
// doesn't pay for the chunk). The branch is dead code in the build.
if (import.meta.env.MODE === 'test') {
  (globalThis as { __nebulaPrimeProjectFlows?: () => Promise<void> }).__nebulaPrimeProjectFlows = async () => {
    // A file whose mocks can't carry the flows' own imports (a partial mock of
    // lib/backend, say) runs with the chunk cold: only a test that presses a
    // flow needs it, and it fails there, in the open, rather than in every test.
    try { primeProjectFlowsForTests(await import('./projectFlows')); } catch { /* cold */ }
  };
}

/** Tests: the flows as if loaded already (tests/setup), or not (`null`). */
export function primeProjectFlowsForTests(module: ProjectFlows | null): void {
  loaded = module;
  chunk = deferredModule(() => importFlows());
}

/** Tests: how the chunk loads (a failing import, say); null for the real one. */
export function setProjectFlowsImportForTests(load: (() => Promise<ProjectFlows>) | null): void {
  importFlows = load ?? (() => import('./projectFlows'));
  loaded = null;
  chunk = deferredModule(() => importFlows());
}
