import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * React.lazy with a `preload()` that can start the chunk early (on idle or on
 * intent). Once the chunk has arrived, the lazy factory hands React a thenable
 * that resolves synchronously, so the first render after a preload never
 * suspends and the Suspense fallback never flashes.
 *
 * Kept out of the startup entry on purpose: anything wrapped here is split
 * into its own chunk. `tests/entrySplit.test.ts` fails if a split module is
 * reached by a static import from `src/main.tsx`.
 */
export type PreloadableComponent<P> = LazyExoticComponent<ComponentType<P>> & {
  readonly preload: () => Promise<unknown>;
};

export function lazyWithPreload<M, P extends object>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): PreloadableComponent<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;

  const preload = (): Promise<ComponentType<P>> => {
    if (!pending) {
      pending = load().then((module) => {
        loaded = pick(module);
        return loaded;
      });
      // A failed fetch (offline, redeploy) may be retried by the next intent.
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };

  const Component = lazy(() => {
    const ready = loaded;
    if (ready) {
      const syncThenable = {
        then(resolve: (module: { default: ComponentType<P> }) => void) {
          resolve({ default: ready });
        },
      };
      return syncThenable as unknown as Promise<{ default: ComponentType<P> }>;
    }
    return preload().then((component) => ({ default: component }));
  });

  return Object.assign(Component, { preload });
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Run `task` once the browser is idle after the next paint (at most `timeout`
 * ms after that paint). A requestAnimationFrame callback runs just before a
 * frame is painted, so a timer queued from it runs after the paint; only then
 * is the idle callback requested. Returns a cancel function for effect cleanup.
 */
export function whenIdle(task: () => void, timeout = 2_000): () => void {
  if (typeof window === 'undefined') return () => {};
  const idleWindow = window as IdleWindow;
  let cancelled = false;
  let frame: number | undefined;
  let timer: number | undefined;
  let idle: number | undefined;
  const afterPaint = () => {
    if (cancelled) return;
    if (idleWindow.requestIdleCallback) {
      idle = idleWindow.requestIdleCallback(() => { if (!cancelled) task(); }, { timeout });
    } else {
      timer = window.setTimeout(() => { if (!cancelled) task(); }, Math.min(timeout, 500));
    }
  };
  if (typeof window.requestAnimationFrame === 'function') {
    frame = window.requestAnimationFrame(() => { timer = window.setTimeout(afterPaint, 0); });
  } else {
    timer = window.setTimeout(afterPaint, 0);
  }
  return () => {
    cancelled = true;
    if (frame !== undefined) window.cancelAnimationFrame?.(frame);
    if (timer !== undefined) window.clearTimeout(timer);
    if (idle !== undefined) idleWindow.cancelIdleCallback?.(idle);
  };
}

/** Start a set of preloads; a rejected preload is ignored (the lazy render retries). */
export function preloadAll(preloads: readonly (() => Promise<unknown>)[]): void {
  for (const preload of preloads) void preload().catch(() => {});
}
