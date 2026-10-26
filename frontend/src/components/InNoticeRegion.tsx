import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNoticeSlot, type NoticeSlot } from '../lib/noticeSlots';

/**
 * Draws a notice or toast in its slot in the app's one notice region
 * (NoticeRegion; lib/noticeSlots.ts), from wherever its state lives. App
 * mounts the region on every screen, so in the app every item lands there.
 * Rendered on its own (a component test without the region), it stays in place.
 */
export function InNoticeRegion({ slot, children }: { slot: NoticeSlot; children: ReactNode }) {
  const target = useNoticeSlot(slot);
  return target ? createPortal(children, target) : <>{children}</>;
}
