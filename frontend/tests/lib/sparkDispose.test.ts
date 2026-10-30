import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeSparkQuietly, isSparkWorkerTerminate, SPARK_WORKER_TERMINATE } from '../../src/lib/sparkDispose';

/** Spark's SplatWorker.dispose rejects in-flight calls with
 * Error("Worker terminate"), and SparkRenderer's sort never catches it. */
function rejection(reason: unknown): PromiseRejectionEvent {
  const event = new Event('unhandledrejection', { cancelable: true }) as PromiseRejectionEvent;
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('disposeSparkQuietly', () => {
  it('disposes, then marks only Spark\'s own "Worker terminate" handled, for a few seconds', () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    disposeSparkQuietly({ dispose });
    expect(dispose).toHaveBeenCalledTimes(1);

    const terminate = rejection(new Error(SPARK_WORKER_TERMINATE));
    window.dispatchEvent(terminate);
    expect(terminate.defaultPrevented).toBe(true);

    for (const other of [new Error('Worker terminated'), new Error('boom'), SPARK_WORKER_TERMINATE, undefined]) {
      const event = rejection(other);
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }

    vi.advanceTimersByTime(3_001);
    const late = rejection(new Error(SPARK_WORKER_TERMINATE));
    window.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(false);
  });

  it('keeps listening until the last of several disposes has had its grace', () => {
    vi.useFakeTimers();
    disposeSparkQuietly({ dispose: vi.fn() });
    vi.advanceTimersByTime(2_000);
    disposeSparkQuietly({ dispose: vi.fn() });
    vi.advanceTimersByTime(1_500);
    const event = rejection(new Error(SPARK_WORKER_TERMINATE));
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(2_000);
  });

  it('matches only an Error with exactly that message', () => {
    expect(isSparkWorkerTerminate(new Error('Worker terminate'))).toBe(true);
    expect(isSparkWorkerTerminate({ message: 'Worker terminate' })).toBe(false);
    expect(isSparkWorkerTerminate(new Error('Worker terminate '))).toBe(false);
  });
});
