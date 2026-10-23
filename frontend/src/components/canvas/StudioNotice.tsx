import { CanvasUndoNotice } from './CanvasUndoNotice';
import '../../styles/canvasProposals.css';

/**
 * The canvas notice on the screens that aren't the canvas (Cinema, Create,
 * the editors): a line that used to be a window.alert reaches the person
 * wherever they are (error copy round 3f). On the canvas the notice sits in
 * the proposal bar's panel (ProposalBar); here it sits at the bottom centre.
 * Only written lines: an agent edit's Undo belongs to the canvas.
 */
export function StudioNotice() {
  return (
    <div className="studio-notice">
      <CanvasUndoNotice messagesOnly />
    </div>
  );
}
