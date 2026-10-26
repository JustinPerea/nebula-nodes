import { vi } from 'vitest';
import { useGraphStore } from '../../src/store/graphStore';

/**
 * Error copy round 3f (GM): "Every error alert becomes a canvas notice". A
 * test that checked window.alert reads each new notice graphStore.notify
 * shows (an undoNotice with a tone) through this spy instead, with its text
 * as the one argument, so `toHaveBeenCalledWith(line)` reads as before.
 */
export function noticeSpy() {
  const spy = vi.fn<(text: string) => void>();
  useGraphStore.subscribe((state, previous) => {
    const notice = state.undoNotice;
    if (notice?.tone && notice !== previous.undoNotice) spy(notice.text);
  });
  return spy;
}
