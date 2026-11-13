import { useEffect, useId, useRef } from 'react';
import { ModalPortal } from '../ModalPortal';
import { FORGET_BODY, FORGET_LABEL, forgetHeading } from '../../lib/worldLabsWaiting';
import '../../styles/prompt-dialog.css';
import { useCanvasLock } from '../../lib/canvasLock';

/** Run History's "Forget ID" confirm (GM - Design, round 13 of PR #114), in
 * the app's own dialog on the page body, never window.confirm. The same
 * pattern as the Projects screen's "Continue without them" confirm
 * (UnsavedEditsNotice): focus starts on Cancel, Escape is Cancel, Tab stays
 * inside, and focus goes back where it was when it closes. The forget runs
 * only from its "Forget ID" button.
 *
 * Round 14 (GM): Cancel on the left, "Forget ID" on the right in the
 * destructive style (the selection toolbar trash's red text on the secondary
 * button; orange is run/go). Review 13, L5: the dialog owns Escape and Tab
 * whenever it is open, however focus got where it is (a click on the
 * backdrop sent it to the page), through a capture listener on the document,
 * so Escape never reaches Run History or the rail behind it; the backdrop
 * keeps focus where it was. It renders only while Run History is visible,
 * and closing Run History cancels it (review 14, nit 1: the old `closing`
 * prop could never be true, so it is gone). Offline (round 15), its "Forget
 * ID" is disabled, as the row's is; Cancel still closes it. */
export function ForgetRecoveryConfirm({ name, onCancel, onConfirm }: {
  /** The node as recordNodeName says it (quoted card title, or the removed forms). */
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const lock = useCanvasLock();
  const headingId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);

  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const buttons = [...(card.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      const inside = card.current?.contains(document.activeElement) ?? false;
      if (!inside) {
        event.preventDefault();
        (cancel.current ?? first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Through ModalPortal, as every modal in the app (#195's review 9; the
  // round 21 merge).
  return (
    <ModalPortal>
    {/* A press on the backdrop keeps focus in the dialog (it did nothing else
        before either; nothing outside it can be used while it is open). */}
    <div className="prompt-dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}>
      <div ref={card} className="prompt-dialog__card" role="alertdialog" aria-modal="true"
        aria-labelledby={headingId} aria-describedby={bodyId}>
        <h2 id={headingId} className="prompt-dialog__heading">{forgetHeading(name)}</h2>
        <p id={bodyId} className="prompt-dialog__line">{FORGET_BODY}</p>
        <div className="prompt-dialog__actions">
          <button type="button" ref={cancel} onClick={onCancel}>Cancel</button>
          {/* Forgetting writes the node's recovery (deleteProviderRecovery):
              the canvas lock, following as well as offline (fix round 2 of
              PR #200, review 2 L-5). */}
          <button type="button" className="prompt-dialog__destructive" {...lock.act({ offline: true, kept: 'forget' })}
            onClick={onConfirm}>{FORGET_LABEL}</button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
