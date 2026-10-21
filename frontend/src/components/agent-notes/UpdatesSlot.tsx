import { useLayoutEffect, useRef } from 'react';

/** Sent when a screen's slot for the Updates chip mounts, resizes or leaves. */
export const UPDATES_SLOT_EVENT = 'nebula:updates-slot';

/**
 * The room a screen's header keeps for the Updates chip (Q107 a): the chip
 * (mounted once by App, components/agent-notes) sits over it, so it never
 * covers that screen's own controls. It takes room only while the chip shows
 * (layouts.css). It tells the chip when it appears or changes size, since a
 * studio's header can arrive after the chip did (its chunk loads later).
 */
export function UpdatesSlot() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const notify = () => window.dispatchEvent(new Event(UPDATES_SLOT_EVENT));
    notify();
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(notify) : null;
    resize?.observe(el);
    return () => {
      resize?.disconnect();
      notify();
    };
  }, []);
  return <span ref={ref} className="agent-notes-slot" aria-hidden="true" />;
}
