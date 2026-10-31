/**
 * Spark (@sparkjsdev/spark 2.x) disposes its workers with `SplatWorker.dispose()`,
 * which rejects every call still in flight with `new Error("Worker terminate")`.
 * SparkRenderer starts its depth sort as a fire-and-forget promise
 * (`this.driveSort()` with no catch), so closing a World viewer while a sort
 * is running, or after a load failed, leaves that rejection unhandled: the
 * page reports "Worker terminate" as an uncaught error (PR #203 review, 6
 * such errors after rapid open-and-close and the damaged-file cards).
 *
 * Nothing is lost: the worker is gone because we asked for it. So around our
 * own dispose, and only for that exact message, the rejection is marked
 * handled. Any other unhandled rejection still reports as before.
 */

export const SPARK_WORKER_TERMINATE = 'Worker terminate';
/** How long after a dispose its rejection may still arrive. */
const GRACE_MS = 3_000;

let pending = 0;

export function isSparkWorkerTerminate(reason: unknown): boolean {
  return reason instanceof Error && reason.message === SPARK_WORKER_TERMINATE;
}

function onRejection(event: PromiseRejectionEvent): void {
  if (isSparkWorkerTerminate(event.reason)) event.preventDefault();
}

/** `target.dispose()`, with Spark's own "Worker terminate" rejections that
 * follow it marked handled. */
export function disposeSparkQuietly(target: { dispose: () => void }): void {
  if (typeof window !== 'undefined') {
    if (pending === 0) window.addEventListener('unhandledrejection', onRejection);
    pending += 1;
    window.setTimeout(() => {
      pending -= 1;
      if (pending === 0) window.removeEventListener('unhandledrejection', onRejection);
    }, GRACE_MS);
  }
  target.dispose();
}

/** The SparkRenderer fields its depth sort is driven by (Spark 2.1.0,
 * SparkRenderer.d.ts: public). */
export interface SortDriver {
  sorting: boolean;
  sortDirty: boolean;
  sortTimeoutId: number;
}

/**
 * Review r4 NIT-3: a drag marks the sort dirty, and Spark waits out its
 * minimum sort interval with a `setTimeout` that calls `driveSort()` again.
 * Disposed before it fires (Escape mid-drag), that sort reads the disposed
 * render target and throws "No target" from a promise nothing catches. Before
 * the renderer is disposed, its pending sort is cancelled and nothing is left
 * marked dirty, so no sort starts after it. Off the scene, nothing marks it
 * dirty again (only its onBeforeRender does), so the `driveSort()` a running
 * sort ends with returns at once.
 */
export function stopSparkSorting(renderer: SortDriver): void {
  if (renderer.sortTimeoutId !== -1) {
    clearTimeout(renderer.sortTimeoutId);
    renderer.sortTimeoutId = -1;
  }
  renderer.sortDirty = false;
}

/** How often a teardown looks whether the running sort has settled, and how
 * long it waits at most. */
export const SORT_SETTLE_POLL_MS = 16;
export const SORT_SETTLE_CAP_MS = 2_000;

/**
 * Review r5 LOW-1 of PR #203: a sort already running when the viewer closes
 * (Spark's `sorting`) reads the render target after a 1 ms pause, so a
 * dispose then still throws "No target". With no sort queued and none able to
 * start (stopSparkSorting), the dispose waits for the running one to settle,
 * looking every SORT_SETTLE_POLL_MS, at most SORT_SETTLE_CAP_MS. The renderer
 * is already off the scene, so nothing draws meanwhile. No error is caught.
 */
export function disposeSparkWhenSettled(renderer: SortDriver & { dispose: () => void }): void {
  stopSparkSorting(renderer);
  if (!renderer.sorting || typeof window === 'undefined') {
    disposeSparkQuietly(renderer);
    return;
  }
  const started = Date.now();
  const timer = window.setInterval(() => {
    if (renderer.sorting && Date.now() - started < SORT_SETTLE_CAP_MS) return;
    window.clearInterval(timer);
    stopSparkSorting(renderer);
    disposeSparkQuietly(renderer);
  }, SORT_SETTLE_POLL_MS);
}
