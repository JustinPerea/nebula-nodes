import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { RegionNotices } from './canvas/DeferredCanvasOverlays';
import { NOTICE_SLOTS, setNoticeSlot, type NoticeSlot } from '../lib/noticeSlots';
import { keepNoticeFocus, noticeKeys } from '../lib/modalFocus';
import { BANNER_SHOWN_ATTR, TOP_BAR_ATTR, noticeTopLimit } from '../lib/bottomBar';
import {
  TOP_GUTTER, applyNoticeStack, measureNoticeStack, placeNoticeStack, stackJumps, type StackPlace,
} from '../lib/noticeStackPlace';
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
 * The band: an empty box one notice plus its gap tall, on the notices' bottom
 * line, always there. Floating panels stop above it whether or not a notice
 * shows (lib/bottomBar.ts floatingBottomLimit; GM: "The panels never move
 * when a notice comes or goes, and a notice never covers Run / Duplicate /
 * Delete").
 *
 * GM r25 (PR #200 fix round 16): it is its own child of <body>, on a layer
 * above every dialog's backdrop, so a modal that hides the page behind it
 * (inert) never hides the notices, and a click on one never reaches a
 * backdrop. lib/modalFocus.ts makes it the open dialog's second focus region,
 * and (fix round 18, GM r27) gives Escape on a notice one rule everywhere.
 */
/**
 * Keeps the stack placed (lib/noticeStackPlace.ts; GM - Design, PR #216 r3):
 * beside the docked Agent log or, under 400 px of room, above it as one
 * stack, and the proposal card's height cap. Measured again whenever any of
 * its inputs moves: the region or the stack resizing (a notice comes or goes,
 * the card grows), the app's top bars resizing (the selection toolbar), the
 * root's variables (the log docking, moving or being dragged, the bottom
 * bar), the region's own bottom transition ending, and window resizes.
 */
function useStackPlace(regionRef: RefObject<HTMLDivElement | null>, stackRef: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const region = regionRef.current;
    const stack = stackRef.current;
    if (!region || !stack) return undefined;
    const watched = new Set<Element>();
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
    const watch = (element: Element | null | undefined) => {
      if (!element || watched.has(element) || !resized) return;
      watched.add(element);
      resized.observe(element);
    };
    let last: { place: StackPlace; logTop: number; floatTop: number } | null = null;
    function place() {
      if (!region || !stack) return;
      // A top bar mounted since (the selection toolbar's panel) joins the watch.
      document.querySelectorAll(`[${TOP_BAR_ATTR}]`).forEach(watch);
      stack.querySelectorAll('[data-notice-shrinks], [data-notice-shrinks] [data-notice-shrink-body] > *').forEach(watch);
      const measured = measureNoticeStack(region, stack, noticeTopLimit(TOP_GUTTER));
      const next = { place: placeNoticeStack(measured), logTop: measured.logTop, floatTop: measured.floating?.top ?? 0 };
      // A layout switch (above the log or back, the log moved) lands with no
      // spring; a notice coming or going keeps it (review 2 MEDIUM-1, GM r4).
      applyNoticeStack(region, stack, next.place, stackJumps(last, next));
      last = next;
    }
    watch(region);
    watch(stack);
    place();
    // The log and the bottom bar write their lines on the root; the offline
    // banner marks it while it shows.
    const rootVars = typeof MutationObserver === 'function' ? new MutationObserver(() => place()) : null;
    rootVars?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', BANNER_SHOWN_ATTR] });
    // An item arriving in or leaving a slot (not the text changing inside one).
    const items = typeof MutationObserver === 'function'
      ? new MutationObserver((records) => {
        if (records.some((record) => (record.target as Element).hasAttribute?.('data-notice-slot'))) place();
      })
      : null;
    items?.observe(stack, { childList: true, subtree: true });
    region.addEventListener('transitionend', place);
    window.addEventListener('resize', place);
    return () => {
      resized?.disconnect();
      rootVars?.disconnect();
      items?.disconnect();
      region.removeEventListener('transitionend', place);
      window.removeEventListener('resize', place);
    };
  }, [regionRef, stackRef]);
}

export function NoticeRegion({ screen }: { screen: NoticeRegionScreen }) {
  const refs = useMemo(() => Object.fromEntries(NOTICE_SLOTS.map((name) => [
    name, (element: HTMLDivElement | null) => setNoticeSlot(name, element),
  ])) as Record<NoticeSlot, (element: HTMLDivElement | null) => void>, []);

  // GM r27 item 1: Escape on a notice closes that notice, in every dialog.
  // Review 15 LOW-B: a replaced notice's focus goes back into the open dialog.
  const regionRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  useStackPlace(regionRef, stackRef);
  useEffect(() => {
    window.addEventListener('keydown', noticeKeys, true);
    const region = regionRef.current;
    const stopKeeping = region ? keepNoticeFocus(region) : () => {};
    return () => { window.removeEventListener('keydown', noticeKeys, true); stopKeeping(); };
  }, []);

  return createPortal(
    <div ref={regionRef} className="notice-region" data-notice-region="">
      <div className="notice-region__band" data-notice-band="" aria-hidden="true" />
      <div ref={stackRef} className="notice-region__stack">
        {NOTICE_SLOTS.map((name) => (
          <div key={name} ref={refs[name]} className="notice-region__slot" data-notice-slot={name} />
        ))}
      </div>
      {screen !== 'home' && <RegionNotices canvas={screen === 'canvas'} />}
    </div>,
    document.body,
  );
}
