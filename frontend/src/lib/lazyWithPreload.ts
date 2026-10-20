import { createElement, lazy, type ComponentType, type FunctionComponent } from 'react';

/**
 * React.lazy with a `preload()` that can start the chunk early (on idle or on
 * intent). Once the chunk has arrived, the lazy factory hands React a thenable
 * that resolves synchronously, so the first render after a preload never
 * suspends and the Suspense fallback never flashes.
 *
 * A chunk can fail to load (web build replaced under an open tab, offline).
 * React.lazy keeps a rejection for good, so the component returned here
 * renders the *current* lazy instance, and a new load attempt (a retry, an
 * idle or hover preload) swaps in a fresh one. The swap happens when an
 * attempt starts, never on the rejection itself: React re-renders the
 * suspended piece right after the rejection, and a fresh instance there would
 * fetch again on every render, a loop. `retry()`, `failures()` and
 * `subscribe()` let DeferredBoundary try again on intent, 'online' and focus,
 * and recover as soon as any caller brings the chunk in.
 *
 * Calling the same loader again is not enough in Chromium (Chrome and the
 * Electron app): it keeps a failed dynamic import in its module map, so a
 * second import() of the same URL rejects at once without a fetch (checked in
 * headless Chrome 147 and 150, offline, aborted and HTTP 503). Vite's preload
 * helper also never adds a stylesheet it already tried. So an attempt after a
 * failure first adds again any stylesheet an earlier attempt failed on, then
 * calls the loader, and if that rejects naming the chunk's URL, imports the
 * chunk once from that URL with a fresh query. Safari names no URL and does
 * refetch, so it gets the plain loader. At most one extra fetch per attempt.
 *
 * Kept out of the startup entry on purpose: anything wrapped here is split
 * into its own chunk. `tests/entrySplit.test.ts` fails if a split module is
 * reached by a static import from `src/main.tsx`.
 */

/**
 * What asked for a retry: an explicit open, a new mount of the piece after an
 * old failure, the network coming back, or window focus.
 */
export type RetryTrigger = 'intent' | 'mount' | 'online' | 'focus';

/** The part of a deferred component DeferredBoundary needs to retry it. */
export interface DeferredChunk {
  readonly preload: () => Promise<unknown>;
  /** One load attempt for `trigger` (mount and focus are skipped offline; focus is spaced out). */
  readonly retry: (trigger: RetryTrigger) => Promise<unknown>;
  readonly isLoaded: () => boolean;
  /** How many load attempts have failed so far. */
  readonly failures: () => number;
  /** Called once the chunk has loaded; returns an unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

export type PreloadableComponent<P> = FunctionComponent<P> & DeferredChunk;

/** How an attempt after a failure reaches the network; the defaults use the DOM (tests pass stubs). */
export interface ChunkRetryIO {
  /** import() a chunk from a URL the bundler does not know. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Add a stylesheet and settle once it has loaded or failed. */
  readonly loadStyle?: (url: string) => Promise<void>;
}

/** Minimum gap between two focus-triggered fetches of one chunk. */
export const FOCUS_RETRY_GAP_MS = 10_000;

/** Each load error, and the chunk whose load it was. */
const chunkLoadErrors = new WeakMap<object, DeferredChunk>();

/**
 * True for an error that came from `chunk` (any deferred chunk, if omitted)
 * failing to load, not from rendering it. A boundary asks about its own
 * chunk: a load error of a chunk deeper down is that chunk's to retry.
 */
export function isChunkLoadError(error: unknown, chunk?: DeferredChunk): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const owner = chunkLoadErrors.get(error);
  return owner !== undefined && (chunk === undefined || owner === chunk);
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '';

/** Only this app's own files are fetched again (the URL comes from an error message). */
function ownUrl(url: string | undefined): string | undefined {
  if (!url || typeof location === 'undefined') return undefined;
  try {
    return new URL(url, location.href).origin === location.origin ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The chunk URL a failed import() names (Chromium, Firefox); Safari names none. */
export function failedModuleUrl(error: unknown): string | undefined {
  return ownUrl(/dynamically imported module:?\s+(\S+)/i.exec(errorMessage(error))?.[1]);
}

/** The stylesheet Vite's preload helper could not load before it imported the chunk. */
export function failedStyleUrl(error: unknown): string | undefined {
  return ownUrl(/Unable to preload CSS for\s+(\S+)/.exec(errorMessage(error))?.[1]);
}

let freshUrls = 0;
/** The same URL with a query no earlier attempt used, so the browser fetches it. */
export function freshUrl(url: string): string {
  freshUrls += 1;
  return `${url}${url.includes('?') ? '&' : '?'}retry=${Date.now().toString(36)}${freshUrls}`;
}

const defaultImportModule = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);

function defaultLoadStyle(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.crossOrigin = '';
    link.href = url;
    link.addEventListener('load', () => resolve());
    link.addEventListener('error', () => {
      link.remove();
      reject(new Error(`Unable to preload CSS for ${url}`));
    });
    document.head.appendChild(link);
  });
}

export function lazyWithPreload<M, P extends object>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
  io: ChunkRetryIO = {},
): PreloadableComponent<P> {
  const importModule = io.importModule ?? defaultImportModule;
  const loadStyle = io.loadStyle ?? defaultLoadStyle;
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  let lastFocusRetry = -Infinity;
  let failures = 0;
  // The lazy instance rendered now, and whether it holds a rejection.
  let current: ReturnType<typeof makeLazy>;
  let currentFailed = false;
  // The current instance's factory ran and waits on `pending`: if that
  // attempt fails, the instance holds the rejection.
  let currentWaiting = false;
  // Stylesheets an earlier attempt could not load (Vite will not add them again).
  const failedStyles = new Set<string>();
  const listeners = new Set<() => void>();

  // One attempt. After a failure, see the note at the top: add failed
  // stylesheets again, then the loader, then the chunk from a fresh URL.
  const viaLoader = (): Promise<M> => load().catch((error: unknown) => {
    const style = failedStyleUrl(error);
    if (style) failedStyles.add(style);
    throw error;
  });
  const attemptLoad = async (): Promise<M> => {
    if (failures === 0) return viaLoader();
    for (const style of [...failedStyles]) {
      await loadStyle(freshUrl(style));
      failedStyles.delete(style);
    }
    try {
      return await viaLoader();
    } catch (error) {
      const url = failedModuleUrl(error);
      if (!url) throw error;
      return (await importModule(freshUrl(url))) as M;
    }
  };

  const preload = (): Promise<ComponentType<P>> => {
    if (loaded) return Promise.resolve(loaded);
    if (!pending) {
      if (currentFailed) {
        // A new attempt: the next render gets a lazy instance that waits for it.
        current = makeLazy();
        currentFailed = false;
      }
      const attempt = attemptLoad().then((module) => {
        loaded = pick(module);
        pending = undefined;
        currentWaiting = false;
        for (const listener of [...listeners]) listener();
        return loaded;
      }, (error: unknown) => {
        // A failed fetch (offline, redeploy) may be retried by the next trigger.
        pending = undefined;
        failures += 1;
        // Marked here, before any other caller can start the next attempt, so
        // that attempt swaps the instance out.
        if (currentWaiting) {
          currentFailed = true;
          currentWaiting = false;
        }
        if (typeof error === 'object' && error !== null) chunkLoadErrors.set(error, chunk);
        throw error;
      });
      pending = attempt;
    }
    return pending;
  };

  const retry = (trigger: RetryTrigger): Promise<unknown> => {
    if (loaded || pending) return preload();
    // A node card can remount often (scrolling, switching canvases), and focus
    // fires on every window switch: neither fetches while offline.
    if ((trigger === 'mount' || trigger === 'focus') && typeof navigator !== 'undefined' && navigator.onLine === false) {
      return Promise.reject(new Error('offline'));
    }
    if (trigger === 'focus') {
      // At most once per gap, so a chunk that is gone for good is not
      // refetched on every glance at the window.
      const now = Date.now();
      if (now - lastFocusRetry < FOCUS_RETRY_GAP_MS) return Promise.reject(new Error('retried recently'));
      lastFocusRetry = now;
    }
    return preload();
  };

  function makeLazy() {
    const instance = lazy(() => {
      const ready = loaded;
      if (ready) {
        const syncThenable = {
          then(resolve: (module: { default: ComponentType<P> }) => void) {
            resolve({ default: ready });
          },
        };
        return syncThenable as unknown as Promise<{ default: ComponentType<P> }>;
      }
      // This instance now waits on the attempt; if it fails, the instance
      // holds the rejection for good and the next attempt replaces it.
      const attempt = preload();
      if (current === instance && !loaded) currentWaiting = true;
      return attempt.then((component) => ({ default: component }));
    });
    return instance;
  }
  current = makeLazy();

  const Deferred: FunctionComponent<P> = (props) => {
    // Belt and braces: once the chunk is in, never draw an instance that
    // holds an old rejection (the boundary would catch it again and again).
    if (loaded && currentFailed) {
      current = makeLazy();
      currentFailed = false;
    }
    return createElement(current as ComponentType<P>, props);
  };
  Deferred.displayName = 'Deferred';

  const chunk: PreloadableComponent<P> = Object.assign(Deferred, {
    preload,
    retry,
    isLoaded: () => loaded !== undefined,
    failures: () => failures,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  return chunk;
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
