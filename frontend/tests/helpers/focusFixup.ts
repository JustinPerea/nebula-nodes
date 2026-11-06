/**
 * PR #204 round 18l (review 17 MEDIUM-1): jsdom has no focus fixup. Chrome, when the focused
 * element becomes disabled or lands under [inert], blurs it at the next rendering update and focus
 * falls to <body>. jsdom leaves focus on the disabled control, so a test can pass while the real
 * page drops focus. This helper copies Chrome: a MutationObserver on `disabled` and `inert` that
 * blurs the active element when it is no longer focusable that way.
 *
 * Chrome runs the fixup asynchronously; so does the observer (a microtask). Synchronous tests call
 * `fixup.flush()` where Chrome would have rendered a frame; async tests get it on any await.
 */
import { afterEach, beforeEach } from 'vitest';

export type FocusFixup = { flush: () => void; disconnect: () => void };

/** Whether Chrome's fixup would blur this element: it is disabled, or inside an inert subtree. */
export function fixupWouldBlur(element: Element | null): boolean {
  if (!element || element === document.body) return false;
  if (element.matches(':disabled')) return true;
  return element.closest('[inert]') !== null;
}

export function installFocusFixup(root: Node = document): FocusFixup {
  // jsdom's blur() does nothing on an element it no longer counts as focusable (a disabled one), so
  // the carrier of `disabled` (the control, or a disabled fieldset) lets go of it for the blur.
  const check = () => {
    const active = document.activeElement as HTMLElement | null;
    if (!fixupWouldBlur(active)) return;
    const carrier = active!.hasAttribute('disabled') ? active! : active!.closest('fieldset[disabled]');
    if (!carrier) { active!.blur(); return; }
    const value = carrier.getAttribute('disabled')!;
    carrier.removeAttribute('disabled');
    active!.blur();
    carrier.setAttribute('disabled', value);
    observer.takeRecords();
  };
  const observer = new MutationObserver(check);
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['disabled', 'inert'] });
  return {
    flush: () => { observer.takeRecords(); check(); },
    disconnect: () => observer.disconnect(),
  };
}

/** Installs the fixup around each test in the calling file (named with, not use: not a React hook); `current()` gives this test's one. */
export function withFocusFixup(): { current: () => FocusFixup } {
  let fixup: FocusFixup | null = null;
  beforeEach(() => { fixup = installFocusFixup(); });
  afterEach(() => { fixup?.disconnect(); fixup = null; });
  return { current: () => { if (!fixup) throw new Error('withFocusFixup: no test is running'); return fixup; } };
}
