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
