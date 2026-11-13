import { act } from '@testing-library/react';
import { vi } from 'vitest';

/** A manual animation-frame queue (review 21 LOW-1 on PR #199): a live
 * region's text arrives from the second frame after its commit
 * (lib/useAnnounced), so a test says when frames happen. `install()` before
 * the render; `flush(n)` runs n frames, each inside act; `pending()` counts
 * the callbacks still queued. */
export function frames() {
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  return {
    install() {
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = next++; queue.set(id, callback); return id; });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue.delete(id); });
    },
    uninstall() { queue.clear(); vi.unstubAllGlobals(); },
    pending: () => queue.size,
    /** One frame: every callback queued before it runs, those they queue wait for the next. */
    step() {
      const due = [...queue.entries()];
      queue.clear();
      act(() => { for (const [, callback] of due) callback(performance.now()); });
    },
    flush(count = 2) { for (let i = 0; i < count; i++) this.step(); },
  };
}
