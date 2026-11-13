import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { sitsBehind } from '../../lib/modalFocus';

/**
 * What the kept canvas's modal dialogs share (the Discard confirm, GM r20 on
 * PR #199, and the project chooser, GM r24): everything behind the dialog is
 * inert and hidden from assistive technology while it is open (the pattern of
 * the app's other full modals, lib/modalFocus sitsBehind; its own notice is
 * ModalPortal's, GM r25 (4)); focus starts on `initialFocus`, Escape closes,
 * Tab stays inside the card, and focus goes back to `returnTo` when it closes.
 */
export function useAlertDialog({ overlay, card, initialFocus, onClose, returnTo }: {
  overlay: RefObject<HTMLElement | null>; card: RefObject<HTMLElement | null>; initialFocus: RefObject<HTMLElement | null>;
  onClose: () => void; returnTo?: RefObject<HTMLElement | null>;
}): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

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
  }, [overlay]);

  useEffect(() => {
    const back = returnTo?.current ?? document.activeElement;
    initialFocus.current?.focus();
    return () => { if (back instanceof HTMLElement && back.isConnected) back.focus(); };
  }, [returnTo, initialFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const buttons = [...(card.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      const inside = card.current?.contains(document.activeElement) ?? false;
      if (!inside) {
        event.preventDefault();
        (initialFocus.current ?? first).focus();
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
  }, [card, initialFocus]);
}
