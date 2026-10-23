import { CanvasUndoNotice } from './canvas/CanvasUndoNotice';
import { DeferredRunNotice } from './canvas/DeferredRunNotice';
import { StudioNotice } from './canvas/StudioNotice';
import { InNoticeRegion } from './InNoticeRegion';
import '../styles/canvasProposals.css';

/**
 * The region's own notices (a deferred chunk: a notice arrives only after an
 * edit, an undo or a failure, never at the first paint). On the canvas, the
 * proposal's run-later notice (an accepted proposal waiting for the run to
 * finish) and the canvas notice with its Undo or Redo; on the other screens
 * the canvas notice's written lines (StudioNotice).
 */
export function RegionNotices({ canvas }: { canvas: boolean }) {
  return (
    <>
      {canvas && <InNoticeRegion slot="run-later"><DeferredRunNotice /></InNoticeRegion>}
      <InNoticeRegion slot="notice">{canvas ? <CanvasUndoNotice /> : <StudioNotice />}</InNoticeRegion>
    </>
  );
}
