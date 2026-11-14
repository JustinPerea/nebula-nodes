import { useId, useRef, type RefObject } from 'react';
import { ModalPortal } from '../ModalPortal';
import { tabWord } from '../../lib/tabWord';
import { useAlertDialog } from './useAlertDialog';
import '../../styles/prompt-dialog.css';

/** GM r20 on PR #199, verbatim: [Discard edits]'s confirm. */
export const DISCARD_KEPT_TITLE = 'Discard the kept edits?';
export const DISCARD_KEPT_BODY = `They’re only in this ${tabWord()}, so they can’t be brought back.`;
export const DISCARD_EDITS = 'Discard edits';
export const KEEP_THEM = 'Keep them';

/**
 * The confirm before the kept edits are discarded (GM r20 on PR #199), in
 * the app's own dialog, as Run History's Forget ID confirm: focus starts on
 * [Keep them], Escape is Keep them, Tab stays inside, and focus goes back
 * where it was when it closes. The app's order: the safe button on the
 * left, the destructive one on the right in the destructive style.
 *
 * GM r22 (3): it is modal (aria-modal) under the ModalPortal rule, so the
 * page behind it is inert. GM r25 (4): so is every notice already showing,
 * the kept notice that opened it included, dimmed under the scrim
 * (ModalPortal's shared hold); a notice that arrives while it is open lands
 * above it, live. Escape closes it and focus goes back to [Discard edits]
 * (`returnTo`).
 */
export function KeptDiscardConfirm({ onKeep, onDiscard, returnTo }: { onKeep: () => void; onDiscard: () => void;
  /** Where focus goes when it closes ([Discard edits]). */
  returnTo?: RefObject<HTMLElement | null> }) {
  const headingId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useAlertDialog({ overlay, card, initialFocus: keep, onClose: onKeep, returnTo });

  return (
    <ModalPortal>
    <div ref={overlay} className="prompt-dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}>
      <div ref={card} className="prompt-dialog__card" role="alertdialog" aria-modal="true"
        aria-labelledby={headingId} aria-describedby={bodyId} data-kept-discard="">
        <h2 id={headingId} className="prompt-dialog__heading">{DISCARD_KEPT_TITLE}</h2>
        <p id={bodyId} className="prompt-dialog__line">{DISCARD_KEPT_BODY}</p>
        <div className="prompt-dialog__actions">
          <button type="button" ref={keep} onClick={onKeep}>{KEEP_THEM}</button>
          <button type="button" className="prompt-dialog__destructive" onClick={onDiscard}>{DISCARD_EDITS}</button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
