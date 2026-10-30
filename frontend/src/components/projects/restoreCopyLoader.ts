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

export function loadRestoreCopy(): Promise<RestoreCopy> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import('./catalogRestoreCopy').then((module) => { loaded = module; return module; });
  return loading;
}

/** The copy now, or null while it loads. */
export function restoreCopyNow(): RestoreCopy | null {
  return loaded;
}

/** Runs `then` with the copy: at once when it is in, else once it loads. */
export function withRestoreCopy(then: (copy: RestoreCopy) => void): void {
  if (loaded) { then(loaded); return; }
  void loadRestoreCopy().then(then, () => undefined);
}

/** The copy for a component that needs it while `needed`; null until loaded. */
export function useRestoreCopy(needed: boolean): RestoreCopy | null {
  const [copy, setCopy] = useState<RestoreCopy | null>(loaded);
  useEffect(() => {
    if (!needed || copy) return undefined;
    let live = true;
    void loadRestoreCopy().then((module) => { if (live) setCopy(module); }, () => undefined);
    return () => { live = false; };
  }, [needed, copy]);
  return copy ?? (needed ? loaded : null);
}

/** Tests: the copy as if it had loaded already (tests/setup), or not (`null`). */
export function primeRestoreCopyForTests(module: RestoreCopy | null): void {
  loaded = module;
  loading = null;
}
