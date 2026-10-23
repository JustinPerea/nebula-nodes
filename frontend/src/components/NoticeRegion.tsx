import { useLayoutEffect, useRef } from 'react';
import { CanvasUndoNotice } from './canvas/CanvasUndoNotice';
import { DeferredRunNotice } from './canvas/DeferredRunNotice';
import { StudioNotice } from './canvas/StudioNotice';
import '../styles/canvasProposals.css';

/** How tall the notices are, with their gap, for the proposal bar to stay above (canvasProposals.css). */
const NOTICE_STACK_VAR = '--notice-stack-h';
const NOTICE_GAP = 8;

/**
 * The app's one notice region (GM - Design, 2026-10-23): "Put notices in one
 * app-level region above every panel (above layer 10), bottom-centre,
 * sitting just above the bottom bar. Proposal-bar notices and every 3g canvas
 * notice go there ... A notice with an action never sits under anything, and
 * the region never takes pointer events outside its notices."
 *
 * App mounts it once, beside the screens: outside `.react-flow` (a z-index 0
 * stacking context, where a floating panel covered the notice) and outside
 * every Studio's own layer. On the canvas it holds the proposal bar's notice
 * (an accepted proposal waiting for the run to finish) and the canvas notice
 * with its Undo or Redo; on the other screens the canvas notice's written
 * lines (StudioNotice). Each notice keeps its own role, buttons and hold.
 */
export function NoticeRegion({ canvas }: { canvas: boolean }) {
  const stack = useRef<HTMLDivElement>(null);

  // The proposal bar sits above the notices, as it did when they shared its
  // panel: publish how much room they take, so it lifts by exactly that.
  useLayoutEffect(() => {
    const element = stack.current;
    const root = document.documentElement;
    if (!element) return;
    const publish = () => {
      const height = element.getBoundingClientRect().height;
      if (height > 0) root.style.setProperty(NOTICE_STACK_VAR, `${Math.ceil(height) + NOTICE_GAP}px`);
      else root.style.removeProperty(NOTICE_STACK_VAR);
    };
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(element);
    const children = typeof MutationObserver === 'function' ? new MutationObserver(publish) : null;
    children?.observe(element, { childList: true });
    return () => {
      observer?.disconnect();
      children?.disconnect();
      root.style.removeProperty(NOTICE_STACK_VAR);
    };
  }, []);

  return (
    <div className="notice-region" data-notice-region="">
      <div ref={stack} className="notice-region__stack">
        {canvas ? (
          <>
            <DeferredRunNotice />
            <CanvasUndoNotice />
          </>
        ) : (
          <StudioNotice />
        )}
      </div>
    </div>
  );
}
