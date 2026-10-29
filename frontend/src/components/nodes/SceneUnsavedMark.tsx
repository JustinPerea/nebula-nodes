import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../asset-move/anchoredPopover';
import { RetrySceneButton } from '../canvas/RetrySceneButton';
import { UNSAVED_MARK } from '../../lib/sceneSaveCopy';
import { noteScenePopover, useGraphStore } from '../../store/graphStore';
import '../../styles/canvasProposals.css';

/**
 * A scene card's "Unsaved" mark (GM r9), its tooltip the line that said why.
 * Once the save stopped retrying by itself (GM r11 answer 3), the mark is a
 * button: a click opens a popover with that line and [Try again] (GM r12
 * item 1), so the retry stays at hand after the toast has gone or another
 * toast took the slot (GM r13 answer 3). The tooltip stays as it is.
 * A click on the mark opens the popover and does nothing else (GM r15
 * answer 3): no selection, no drag start. The node's own handlers (React
 * Flow selects on its click) never see the press; `nodrag` keeps the drag
 * off, and the popover, a portal still inside the card in React's tree,
 * stops its presses the same way. A press released off the mark does
 * nothing (review 10, N-1).
 * GM r22 Q1: while the popover is open, the toast with the same line and
 * [Try again] leaves (as on ×) and none comes back, even once it closes:
 * one line and one [Try again] on screen (graphStore noteScenePopover).
 */
const keepToItself = (event: SyntheticEvent) => event.stopPropagation();
const OWN_PRESSES = { onPointerDown: keepToItself, onMouseDown: keepToItself, onDoubleClick: keepToItself } as const;

/** Review 10, N-1: a press on the mark released off it is cancelled, as on
 * any button. The browser sends that click to the common ancestor (the node,
 * which React Flow would select), so the one click of that release is
 * stopped before anything sees it. Only that release's click: the guard
 * goes in the same task. */
function cancelReleaseOffMark(mark: HTMLElement) {
  const onRelease = (up: PointerEvent) => {
    window.removeEventListener('pointercancel', onCancel, true);
    if (up.target instanceof Node && mark.contains(up.target)) return;
    const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  };
  const onCancel = () => window.removeEventListener('pointerup', onRelease, true);
  window.addEventListener('pointerup', onRelease, { capture: true, once: true });
  window.addEventListener('pointercancel', onCancel, { capture: true, once: true });
}
/** Enter and Space press the mark's buttons; React Flow's node selects on
 * them too, and on Escape (review 11, L-3), so they stay here as well. */
const keepActivationKeys = (event: ReactKeyboardEvent) => {
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') event.stopPropagation();
};
export function SceneUnsavedMark({ nodeId, line, stopped }: { nodeId: string; line: string; stopped: boolean }) {
  const [open, setOpen] = useState(false);
  const markRef = useRef<HTMLButtonElement>(null);
  if (!stopped) {
    return <span className="cinema-scene-node__unsaved" title={line}>{UNSAVED_MARK}</span>;
  }
  return (
    <>
      <button ref={markRef} type="button" title={line} aria-haspopup="dialog" aria-expanded={open}
        className="cinema-scene-node__unsaved cinema-scene-node__unsaved--button nodrag nopan"
        {...OWN_PRESSES}
        onKeyDown={(event) => {
          keepActivationKeys(event);
          // Review 11, L-3: Escape on the mark closes its popover, focus
          // staying on the mark, and never selects the card.
          if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); }
        }}
        onPointerDown={(event) => { event.stopPropagation(); cancelReleaseOffMark(event.currentTarget); }}
        onClick={(event) => { event.stopPropagation(); setOpen((was) => !was); }}>
        {UNSAVED_MARK}
      </button>
      {open && <SceneUnsavedPopover nodeId={nodeId} line={line} anchorRef={markRef} onClose={setOpen} />}
    </>
  );
}

function SceneUnsavedPopover({ nodeId, line, anchorRef, onClose }: {
  nodeId: string;
  line: string;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: (open: false) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lineId = useId();
  const dismiss = useCallback(() => onClose(false), [onClose]);
  const position = useAnchoredPopover(anchorRef, panelRef, dismiss, 'start', 320);
  // GM r30: busy while the scene's [Try again] is on its way.
  const trying = useGraphStore((state) => nodeId in state.sceneTries);

  useEffect(() => {
    noteScenePopover(nodeId, true);
    return () => noteScenePopover(nodeId, false);
  }, [nodeId]);

  useEffect(() => {
    if (position) panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [position]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    keepActivationKeys(event);
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose(false);
    anchorRef.current?.focus();
  };

  const style = (position ? { left: position.left, top: position.top } : { visibility: 'hidden' }) as CSSProperties;
  return createPortal(
    <div ref={panelRef} role="dialog" aria-modal="false" aria-labelledby={lineId} tabIndex={-1} aria-busy={trying || undefined}
      data-scene-unsaved-popover={nodeId} className="canvas-undo-notice scene-unsaved-popover nodrag nopan nowheel" style={style}
      onKeyDown={onKeyDown} {...OWN_PRESSES} onClick={keepToItself}>
      <span id={lineId} className="canvas-undo-notice__text">{line}</span>
      <RetrySceneButton nodeId={nodeId} onRetry={() => onClose(false)} />
    </div>,
    document.body,
  );
}
