import { NOTICE_SLOTS, type NoticeSlot } from './noticeSlots';

/**
 * The notice stack's × rule (ProjectHome useNoticeStackFocus), for an item
 * in `from`'s slot that left the region with focus in it: the nearest notice
 * below, then any left in the same slot, then the nearest above. A notice
 * takes focus on its × (never its action, so a second Enter can't act), or
 * itself when it has no × and takes focus (tabindex -1: a stop line, a clash
 * prompt). Null when none can; the caller then focuses the canvas.
 */
export function nextNoticeTarget(from: NoticeSlot): HTMLElement | null {
  const at = NOTICE_SLOTS.indexOf(from);
  const below = NOTICE_SLOTS.slice(at + 1);
  const above = NOTICE_SLOTS.slice(0, at).reverse();
  for (const slot of [...below, from, ...above]) {
    const box = document.querySelector<HTMLElement>(`[data-notice-slot="${slot}"]`);
    for (const notice of Array.from(box?.children ?? []) as HTMLElement[]) {
      const close = notice.querySelector<HTMLElement>('button[aria-label="Dismiss"]:not(:disabled)');
      if (close) return close;
      if (notice.getAttribute('tabindex') === '-1') return notice;
    }
  }
  return null;
}

/** The canvas, the × rule's last stop. */
export function canvasFocusTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.canvas-wrapper');
}
