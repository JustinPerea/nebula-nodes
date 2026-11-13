import { useEffect, useState } from 'react';

/**
 * Review 13 of PR #199 (merge-integrity LOW-1): the restore notice's copy
 * (catalogRestoreCopy, about 15 KB built) is needed only once Nebula has
 * restored its project list, held a canvas or found one it couldn't read,
 * so it loads then instead of with the entry chunk. The store's Agent log
 * lines wait for it (withRestoreCopy); the home's notices render once it is
 * in (useRestoreCopy). The test setup primes it, so tests read it at once.
 */
export type RestoreCopy = typeof import('./catalogRestoreCopy');

let loaded: RestoreCopy | null = null;
let loading: Promise<RestoreCopy> | null = null;
let importCopy: () => Promise<RestoreCopy> = () => import('./catalogRestoreCopy');

/**
 * Review 14 of PR #199 (lock-order LOW-3): a chunk that failed to load (a
 * dropped connection, a restart serving a new build) is asked for again the
 * next time: a failed load is never kept, as the other deferred chunks
 * retry on focus or reconnect (useRestoreCopyState, withRestoreCopy).
 */
export function loadRestoreCopy(): Promise<RestoreCopy> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= importCopy().then((module) => { loaded = module; return module; },
    (error: unknown) => { loading = null; throw error; });
  return loading;
}

/** Runs `retry` once, at the tab's next focus or reconnect. */
function onNextChance(retry: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const go = () => { stop(); retry(); };
  const stop = () => { window.removeEventListener('online', go); window.removeEventListener('focus', go); };
  window.addEventListener('online', go);
  window.addEventListener('focus', go);
  return stop;
}

/** The copy now, or null while it loads. */
export function restoreCopyNow(): RestoreCopy | null {
  return loaded;
}

/** Runs `then` with the copy: at once when it is in, else once it loads. */
export function withRestoreCopy(then: (copy: RestoreCopy) => void): void {
  if (loaded) { then(loaded); return; }
  void loadRestoreCopy().then(then, () => { onNextChance(() => withRestoreCopy(then)); });
}

/** The copy for a component that needs it while `needed` (null until it
 * loads), and whether its last load failed (the notice then says a
 * readable line of its own, never nothing). A failed load is tried again
 * at the next focus or reconnect. */
export function useRestoreCopyState(needed: boolean): { copy: RestoreCopy | null; failed: boolean } {
  const [copy, setCopy] = useState<RestoreCopy | null>(loaded);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!needed || copy) return undefined;
    let live = true;
    let stop = () => {};
    void loadRestoreCopy().then((module) => { if (live) { setFailed(false); setCopy(module); } }, () => {
      if (!live) return;
      setFailed(true);
      stop = onNextChance(() => setAttempt((count) => count + 1));
    });
    return () => { live = false; stop(); };
  }, [needed, copy, attempt]);
  const now = copy ?? (needed ? loaded : null);
  return { copy: now, failed: failed && !now };
}

/** The copy for a component that needs it while `needed`; null until loaded. */
export function useRestoreCopy(needed: boolean): RestoreCopy | null {
  return useRestoreCopyState(needed).copy;
}

/** Tests: the copy as if it had loaded already (tests/setup), or not (`null`). */
export function primeRestoreCopyForTests(module: RestoreCopy | null): void {
  loaded = module;
  loading = null;
}

/** Tests: how the chunk loads (a failing load, say); null for the real one. */
export function setRestoreCopyImportForTests(load: (() => Promise<RestoreCopy>) | null): void {
  importCopy = load ?? (() => import('./catalogRestoreCopy'));
  loading = null;
}
