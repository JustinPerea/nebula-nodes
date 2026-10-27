import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { FORGET_BODY, FORGET_LABEL, forgetHeading } from '../../lib/worldLabsWaiting';
import '../../styles/prompt-dialog.css';

/** Run History's "Forget ID" confirm (GM - Design, round 13 of PR #114), in
 * the app's own dialog on the page body, never window.confirm. The same
 * pattern as the Projects screen's "Continue without them" confirm
 * (UnsavedEditsNotice): focus starts on Cancel, Escape is Cancel, Tab stays
 * inside, and focus goes back where it was when it closes. The forget runs
 * only from its "Forget ID" button. */
export function ForgetRecoveryConfirm({ node, onCancel, onConfirm }: {
  /** The node's card title. */
  node: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const headingId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Tab') {
      const buttons = card.current?.querySelectorAll<HTMLElement>('button');
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  return createPortal(
    <div className="prompt-dialog">
      <div ref={card} className="prompt-dialog__card" role="alertdialog" aria-modal="true"
        aria-labelledby={headingId} aria-describedby={bodyId} onKeyDown={onKeyDown}>
        <h2 id={headingId} className="prompt-dialog__heading">{forgetHeading(node)}</h2>
        <p id={bodyId} className="prompt-dialog__line">{FORGET_BODY}</p>
        <div className="prompt-dialog__actions">
          <button type="button" className="prompt-dialog__danger" onClick={onConfirm}>{FORGET_LABEL}</button>
          <button type="button" ref={cancel} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
