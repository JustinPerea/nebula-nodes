import { useMemo } from 'react';
import { RegionNotices } from './canvas/DeferredCanvasOverlays';
import { NOTICE_SLOTS, setNoticeSlot, type NoticeSlot } from '../lib/noticeSlots';
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
 */
export function NoticeRegion({ screen }: { screen: NoticeRegionScreen }) {
  const refs = useMemo(() => Object.fromEntries(NOTICE_SLOTS.map((name) => [
    name, (element: HTMLDivElement | null) => setNoticeSlot(name, element),
  ])) as Record<NoticeSlot, (element: HTMLDivElement | null) => void>, []);

  return (
    <div className="notice-region" data-notice-region="">
      <div className="notice-region__band" data-notice-band="" aria-hidden="true" />
      <div className="notice-region__stack">
        {NOTICE_SLOTS.map((name) => (
          <div key={name} ref={refs[name]} className="notice-region__slot" data-notice-slot={name} />
        ))}
      </div>
      {screen !== 'home' && <RegionNotices canvas={screen === 'canvas'} />}
    </div>
  );
}
