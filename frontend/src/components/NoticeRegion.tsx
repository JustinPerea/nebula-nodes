import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RegionNotices } from './canvas/DeferredCanvasOverlays';
import { NOTICE_SLOTS, setNoticeSlot, type NoticeSlot } from '../lib/noticeSlots';
import { keepNoticeFocus, noticeKeys } from '../lib/modalFocus';
import { cappedPopoverOpen, setWaitingNotices, subscribeNoticeWaiting } from '../lib/noticeWaiting';
import '../styles/noticeRegion.css';

/** What a screen shows in the region besides the toasts. */
export type NoticeRegionScreen = 'canvas' | 'studio' | 'home';

/**
 * The app's one notice region (GM - Design, 2026-10-23): "Put notices in one
 * app-level region above every panel (above layer 10), bottom-centre,
 * sitting just above the bottom bar ... A notice with an action never sits
 * under anything, and the region never takes pointer events outside its
 * notices." Round 2: the proposal bar stacks above the notices, and "One
 * region, one stack, and nothing else draws toasts."
 *
 * App mounts it once, on every screen, beside the screens: outside
 * `.react-flow` and every Studio's own layer. It is in the startup entry (a
 * few boxes), so a toast that shows at once already has its slot; its own
 * notices are a deferred chunk (RegionNotices). Its stack has a slot per kind
 * of item (lib/noticeSlots.ts), and each item portals into its slot from
 * wherever its state lives (InNoticeRegion). `screen`: the canvas shows the
 * canvas notice and the proposal's run-later notice, the Studios the canvas
 * notice's written lines, Projects (and the brand demo) only toasts, so a
 * canvas notice set there waits for the workspace, as before.
 *
 * The band: an empty box the tallest single notice (three lines, GM r13 2 of
 * PR #204) plus its gap tall, on the notices' bottom line, always there. Floating panels stop above it whether or not a notice
 * shows (lib/bottomBar.ts floatingBottomLimit; GM: "The panels never move
 * when a notice comes or goes, and a notice never covers Run / Duplicate /
 * Delete").
 *
 * GM r25 (PR #200 fix round 16): it is its own child of <body>, on a layer
 * above every dialog's backdrop, so a modal that hides the page behind it
 * (inert) never hides the notices, and a click on one never reaches a
 * backdrop. lib/modalFocus.ts makes it the open dialog's second focus region,
 * and (fix round 18, GM r27) gives Escape on a notice one rule everywhere.
 *
 * GM r13 (2), PR #204 round 9: while a capped popover is open (lib/noticeWaiting), the band
 * shows only the newest item; the others wait (marked `data-notice-waiting`, drawn as nothing)
 * and come back when it goes or the popover closes. The region keeps each item's arrival, by
 * the element its slot gained.
 */
export function NoticeRegion({ screen }: { screen: NoticeRegionScreen }) {
  const refs = useMemo(() => Object.fromEntries(NOTICE_SLOTS.map((name) => [
    name, (element: HTMLDivElement | null) => setNoticeSlot(name, element),
  ])) as Record<NoticeSlot, (element: HTMLDivElement | null) => void>, []);

  // GM r27 item 1: Escape on a notice closes that notice, in every dialog.
  // Review 15 LOW-B: a replaced notice's focus goes back into the open dialog.
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.addEventListener('keydown', noticeKeys, true);
    const region = regionRef.current;
    const stopKeeping = region ? keepNoticeFocus(region) : () => {};
    return () => { window.removeEventListener('keydown', noticeKeys, true); stopKeeping(); };
  }, []);

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const slots = [...region.querySelectorAll<HTMLElement>('[data-notice-slot]')];
    const arrived = new Map<Element, number>();
    let next = 0;
    for (const slot of slots) for (const item of slot.children) arrived.set(item, next++);
    const apply = () => {
      const items = slots.flatMap((slot) => [...slot.children]);
      for (const item of items) if (!arrived.has(item)) arrived.set(item, next++);
      for (const item of [...arrived.keys()]) if (!item.isConnected || !slots.includes(item.parentElement as HTMLElement)) arrived.delete(item);
      const newest = cappedPopoverOpen() && items.length > 1
        ? items.reduce((a, b) => ((arrived.get(b) ?? 0) > (arrived.get(a) ?? 0) ? b : a)) : null;
      const waits = new Set<Element>();
      for (const item of items) {
        const wait = newest !== null && item !== newest;
        if (wait) waits.add(item);
        if (wait !== item.hasAttribute('data-notice-waiting')) item.toggleAttribute('data-notice-waiting', wait);
      }
      setWaitingNotices(waits);
    };
    const observer = new MutationObserver(apply);
    for (const slot of slots) observer.observe(slot, { childList: true });
    // A popover opening or closing re-reads the stack (the waiting set's own changes don't).
    let wasCapped = cappedPopoverOpen();
    const stop = subscribeNoticeWaiting(() => { if (cappedPopoverOpen() !== wasCapped) { wasCapped = cappedPopoverOpen(); apply(); } });
    apply();
    return () => { observer.disconnect(); stop(); setWaitingNotices(new Set()); };
  }, []);

  return createPortal(
    <div ref={regionRef} className="notice-region" data-notice-region="">
      <div className="notice-region__band" data-notice-band="" aria-hidden="true" />
      <div className="notice-region__stack">
        {NOTICE_SLOTS.map((name) => (
          <div key={name} ref={refs[name]} className="notice-region__slot" data-notice-slot={name} />
        ))}
      </div>
      {screen !== 'home' && <RegionNotices canvas={screen === 'canvas'} />}
    </div>,
    document.body,
  );
}
