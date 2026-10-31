import { CanvasUndoNotice } from './canvas/CanvasUndoNotice';
import { DeferredRunNotice } from './canvas/DeferredRunNotice';
import { StudioNotice } from './canvas/StudioNotice';
import { CanvasLateNotice } from './canvas/CanvasLateNotice';
import { CanvasMessageNotice } from './canvas/CanvasMessageNotice';
import { SceneClashNotices } from './canvas/SceneClashNotice';
import { SceneStopLines } from './canvas/SceneStopLines';
import { InNoticeRegion } from './InNoticeRegion';
import { SavePausedNotice } from './projects/SavePausedNotice';
import { KeptEditsNotice } from './projects/KeptEditsNotice';
import { ProjectSizePanel } from './projects/ProjectSizePanel';
import '../styles/canvasProposals.css';

/**
 * The region's own notices (a deferred chunk: a notice arrives only after an
 * edit, an undo or a failure, never at the first paint). On the canvas, the
 * proposal's run-later notice (an accepted proposal waiting for the run to
 * finish) and the canvas notice with its Undo or Redo; on the other screens
 * the canvas notice's written lines (StudioNotice). On every screen, right
 * above the canvas notice, a restore's late count (CanvasLateNotice), a
 * written line with no Undo or Redo (its slot's place: lib/noticeSlots.ts);
 * above that, a line that arrived while the canvas notice offers Undo or Redo
 * (CanvasMessageNotice, review 7 L3); below it, a Cinema scene's clash
 * prompt, which stays until the person chooses (SceneClashNotices), and
 * the scenes' stop lines, a state that stays until the stop ends (GM r28,
 * SceneStopLines).
 * The canvas kept in this tab after a restore, with [Save as a project]
 * (GM r15 on PR #199). A project over the save limit: its one
 * notice, and the "what's large" panel it and the header open.
 */
export function RegionNotices({ canvas }: { canvas: boolean }) {
  return (
    <>
      {canvas && <InNoticeRegion slot="run-later"><DeferredRunNotice /></InNoticeRegion>}
      <InNoticeRegion slot="notice">{canvas ? <CanvasUndoNotice /> : <StudioNotice />}</InNoticeRegion>
      <InNoticeRegion slot="late"><CanvasLateNotice /></InNoticeRegion>
      <InNoticeRegion slot="scene-clash"><SceneClashNotices /></InNoticeRegion>
      <InNoticeRegion slot="scene-stop"><SceneStopLines /></InNoticeRegion>
      <InNoticeRegion slot="message"><CanvasMessageNotice /></InNoticeRegion>
      <InNoticeRegion slot="kept-edits"><KeptEditsNotice /></InNoticeRegion>
      <InNoticeRegion slot="save-paused"><SavePausedNotice /></InNoticeRegion>
      <ProjectSizePanel />
    </>
  );
}
