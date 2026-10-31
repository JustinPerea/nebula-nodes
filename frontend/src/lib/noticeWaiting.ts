import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * GM r13 (2), PR #204 round 9, verbatim: "The band reserves the tallest single notice (three
 * lines). Two notices covering the picker's last row breaks the stacking rule, since notices
 * shouldn't land on an open popover's content. While a capped popover is open, show only the
 * newest notice in the band. The others wait and appear when it's dismissed or the popover
 * closes."
 *
 * A capped popover is one that stops at the band (lib/bottomBar.ts floatingBottomLimit, or the
 * clearance a modal reads, hooks/useNoticeClearance): the model picker, the Lightbox, the
 * comparison, Styles, the context menu, the connection menu, the provider menu, the size panel
 * and the node's inspector popover. Each holds `useCappedPopover()` while it is open
 * (tests/presenceRound9.band.test.tsx checks every one does).
 *
 * The notice region (components/NoticeRegion) keeps each item's arrival order and, while any
 * capped popover is open, marks every item but the newest `data-notice-waiting` (drawn as
 * nothing). A waiting item stays mounted and keeps its state; a notice that times out holds its
 * timer while it waits (`useSlotWaiting`), so none is lost, and starts a full hold when it
 * shows again.
 */

let capped = 0;
let waiting: ReadonlySet<Element> = new Set();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function subscribeNoticeWaiting(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Holds the band to one notice until the returned release is called (once). */
export function holdCappedPopover(): () => void {
  capped += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    capped -= 1;
    notify();
  };
}

export const cappedPopoverOpen = (): boolean => capped > 0;

/** The notice region's own report of which items wait. */
export function setWaitingNotices(items: ReadonlySet<Element>): void {
  const same = items.size === waiting.size && [...items].every((item) => waiting.has(item));
  if (same) return;
  waiting = items;
  notify();
}

/** Whether an item in this slot of the region is waiting. */
export function slotWaiting(slot: string): boolean {
  for (const item of waiting) {
    if ((item.parentElement as HTMLElement | null)?.dataset.noticeSlot === slot) return true;
  }
  return false;
}

/** `slotWaiting`, kept current: a timed notice holds its timer while it is true. */
export function useSlotWaiting(slot: string | undefined): boolean {
  return useSyncExternalStore(subscribeNoticeWaiting, () => (slot ? slotWaiting(slot) : false), () => false);
}

/** A capped popover holds the band to one notice while it is mounted and `open`. */
export function useCappedPopover(open = true): void {
  useLayoutEffect(() => (open ? holdCappedPopover() : undefined), [open]);
}

export function resetNoticeWaitingForTests(): void {
  capped = 0;
  waiting = new Set();
  notify();
}
