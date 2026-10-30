import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from 'react';
import { ModalPortal } from '../ModalPortal';
import { sitsBehind } from '../../lib/modalFocus';
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
 *
 * GM r22 (3): it is modal (aria-modal) under the ModalPortal rule, so the
 * page behind it is inert, the kept notice that opened it included: the
 * notice region's other notices stay reachable above it (GM r25), but a
 * notice that owns the open confirm isn't one of them. Escape closes it and
 * focus goes back to [Discard edits] (`returnTo`).
 */
export function KeptDiscardConfirm({ onKeep, onDiscard, owner, returnTo }: { onKeep: () => void; onDiscard: () => void;
  /** The notice whose [Discard edits] opened it: inert while it is open. */
  owner?: RefObject<HTMLElement | null>;
  /** Where focus goes when it closes ([Discard edits]). */
  returnTo?: RefObject<HTMLElement | null> }) {
  const headingId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const onKeepRef = useRef(onKeep);
  useEffect(() => { onKeepRef.current = onKeep; }, [onKeep]);

  const overlay = useRef<HTMLDivElement>(null);
  // Everything behind the confirm is inert and hidden from assistive
  // technology while it is open (the pattern of the app's other full modals,
  // lib/modalFocus sitsBehind), and so is its own notice.
  useLayoutEffect(() => {
    const own = overlay.current;
    if (!own) return undefined;
    const background = new Map<Element, { inert: string | null; hidden: string | null }>();
    const hide = (element: Element) => {
      if (background.has(element)) return;
      background.set(element, { inert: element.getAttribute('inert'), hidden: element.getAttribute('aria-hidden') });
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    };
    const isolate = () => {
      for (const sibling of document.body.children) if (sitsBehind(sibling, own)) hide(sibling);
      if (owner?.current) hide(owner.current);
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      for (const [element, prior] of background) {
        if (prior.inert === null) element.removeAttribute('inert');
        else element.setAttribute('inert', prior.inert);
        if (prior.hidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', prior.hidden);
      }
    };
  }, [owner]);

  useEffect(() => {
    const back = returnTo?.current ?? document.activeElement;
    keep.current?.focus();
    return () => { if (back instanceof HTMLElement && back.isConnected) back.focus(); };
  }, [returnTo]);

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
