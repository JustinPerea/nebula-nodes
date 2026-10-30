import { useEffect, useId, useRef } from 'react';
import { ModalPortal } from '../ModalPortal';
import '../../styles/prompt-dialog.css';

/** GM r20 on PR #199, verbatim: [Discard edits]'s confirm. */
export const DISCARD_KEPT_TITLE = 'Discard the kept edits?';
export const DISCARD_KEPT_BODY = 'They’re only in this tab, so they can’t be brought back.';
export const DISCARD_EDITS = 'Discard edits';
export const KEEP_THEM = 'Keep them';

/**
 * The confirm before the kept edits are discarded (GM r20 on PR #199), in
 * the app's own dialog, as Run History's Forget ID confirm: focus starts on
 * [Keep them], Escape is Keep them, Tab stays inside, and focus goes back
 * where it was when it closes. The app's order: the safe button on the
 * left, the destructive one on the right in the destructive style.
 */
export function KeptDiscardConfirm({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const headingId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const onKeepRef = useRef(onKeep);
  useEffect(() => { onKeepRef.current = onKeep; }, [onKeep]);

  useEffect(() => {
    const previous = document.activeElement;
    keep.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onKeepRef.current();
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
        (keep.current ?? first).focus();
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

  return (
    <ModalPortal>
    <div className="prompt-dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}>
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
