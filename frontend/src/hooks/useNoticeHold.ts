import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { noticeHoldMs } from '../lib/canvasNoticeHold';
import { useSlotWaiting } from '../lib/noticeWaiting';

/** What a canvas notice's hold needs to know about it. */
export interface HeldNotice {
  id: number;
  text: string;
  offer?: 'undo' | 'redo' | null;
}

/**
 * A canvas notice's timeout (lib/canvasNoticeHold.ts noticeHoldMs): it goes
 * after its hold unless the pointer is on it or focus is inside it, and once
 * both leave it starts a full hold again (WCAG 2.2.1). `isShown` says whether
 * this notice, by id, is still the one in the store when the hold ends, so a
 * newer notice is never dismissed by an older one's timer (pass a stable
 * function). Returns the handlers for the notice's box. `slot`: the region slot it shows in;
 * while it waits there behind a capped popover (GM r13 2, lib/noticeWaiting) it holds too, and
 * starts a full hold when it shows again.
 */
export function useNoticeHold(notice: HeldNotice | null, isShown: (id: number) => boolean, dismiss: () => void, slot?: string) {
  // The notice the pointer or focus is holding up, by id: a new notice starts its own hold.
  const [heldId, setHeldId] = useState<number | null>(null);
  const pointerIn = useRef(false);
  const focusIn = useRef(false);
  const waiting = useSlotWaiting(slot);
  const held = (heldId !== null && heldId === notice?.id) || waiting;

  useEffect(() => {
    if (!notice || held) return;
    const timer = window.setTimeout(() => {
      if (isShown(notice.id)) dismiss();
    }, noticeHoldMs(notice.text, notice.offer ?? null));
    return () => window.clearTimeout(timer);
  }, [notice, dismiss, held, isShown]);

  const hold = () => setHeldId(notice && (pointerIn.current || focusIn.current) ? notice.id : null);
  return {
    onMouseEnter: () => { pointerIn.current = true; hold(); },
    onMouseLeave: () => { pointerIn.current = false; hold(); },
    onFocus: () => { focusIn.current = true; hold(); },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      focusIn.current = event.currentTarget.contains(event.relatedTarget as globalThis.Node | null);
      hold();
    },
  };
}
