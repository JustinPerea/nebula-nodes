import { useEffect, type RefObject } from 'react';
import { refuseEditWhileOffline } from '../lib/backendConnection';

const FIELDS = 'input, textarea, select';
const MARK = 'data-offline-disabled';

/**
 * Offline is read-only (GM - Design, round 14 of PR #114: "Fields are
 * disabled, so they don't take focus for typing."). While `readOnly`, every
 * form field under `root` (node cards, the Inspector) is disabled, ones that
 * render later too, and marked so only those are enabled again on reconnect.
 * Buttons are left alone: viewing outputs, opening menus and the library
 * still work. A press on a disabled field or a port asks the gate, so the
 * banner pulses (the store refuses anything else).
 */
/** `mounted`: whether `root` renders now (a panel that opens later). */
export function useReadOnlyFields(root: RefObject<HTMLElement | null>, readOnly: boolean, mounted = true): void {
  useEffect(() => {
    const element = root.current;
    if (!element || !readOnly) return;
    const disable = (field: Element) => {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
      if (field.disabled && !field.hasAttribute(MARK)) return;
      field.setAttribute(MARK, '');
      field.disabled = true;
    };
    const sweep = () => element.querySelectorAll(FIELDS).forEach(disable);
    sweep();
    if (document.activeElement instanceof HTMLElement && element.contains(document.activeElement)
      && document.activeElement.matches(FIELDS)) document.activeElement.blur();
    // A field that renders later, or one React re-enables, is disabled again.
    const observer = new MutationObserver(sweep);
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    const pressed = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`[${MARK}], .react-flow__handle`)) refuseEditWhileOffline();
    };
    element.addEventListener('pointerdown', pressed, true);
    return () => {
      observer.disconnect();
      element.removeEventListener('pointerdown', pressed, true);
      element.querySelectorAll(`[${MARK}]`).forEach((field) => {
        field.removeAttribute(MARK);
        (field as HTMLInputElement).disabled = false;
      });
    };
  }, [root, readOnly, mounted]);
}
