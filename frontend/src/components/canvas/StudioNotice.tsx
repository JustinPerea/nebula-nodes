import { CanvasUndoNotice } from './CanvasUndoNotice';

/**
 * The canvas notice on the screens that aren't the canvas (Cinema, Create,
 * the editors): a line that used to be a window.alert reaches the person
 * wherever they are (error copy round 3f). It renders in the app's one notice
 * region (NoticeRegion), as the canvas's notices do. Only written lines: an
 * agent edit's Undo belongs to the canvas.
 */
export function StudioNotice() {
  return <CanvasUndoNotice messagesOnly />;
}
