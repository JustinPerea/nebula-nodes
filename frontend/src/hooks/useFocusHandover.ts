import { useCallback, useLayoutEffect, useRef, type FocusEvent } from 'react';

/** The attribute a section's lock or not-connected line carries so a handover can find it. */
export const FOCUS_LINE_ATTR = 'data-focus-line';

const FRAMES = 30;

function labelOf(element: HTMLElement): string | null {
  return element.getAttribute('aria-label') || element.getAttribute('name') || element.id || null;
}

/**
 * PR #204 round 11 (review 9 MEDIUM-3, GM r19 item 2): when a demote (or the promote) takes away
 * the control that had focus, focus moves on instead of dropping to the page: to the same
 * control if it is back (the promote remounts it, matched by its label), else to the section's
 * lock or not-connected line (`data-focus-line`, tabIndex -1), else to its heading. Only when the
 * focused control actually went away: while it is still there, or focus went somewhere else
 * meanwhile, nothing moves. `change` is what removes controls (the demote, the promote).
 * Spread `onFocus` on the section's root.
 */
export function useFocusHandover(change: unknown, root: () => HTMLElement | null, heading: () => HTMLElement | null) {
  const last = useRef<{ element: HTMLElement; label: string | null } | null>(null);
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const element = event.target as HTMLElement;
    last.current = { element, label: labelOf(element) };
  }, []);
  useLayoutEffect(() => {
    const was = last.current;
    if (!was || was.element.isConnected) return undefined;
    let frame = 0;
    let id = 0;
    const lost = () => !document.activeElement || document.activeElement === document.body;
    const attempt = () => {
      if (!lost()) return; // focus went somewhere on its own: leave it
      const scope = root();
      if (!scope) return;
      const same = was.label
        ? [...scope.querySelectorAll<HTMLElement>('[aria-label], [name], [id]')].find((el) => labelOf(el) === was.label
          && !el.matches(':disabled'))
        : undefined;
      const line = scope.querySelector<HTMLElement>(`[${FOCUS_LINE_ATTR}]`);
      // The line can arrive a moment later (a held read answers on the next tick): wait for it.
      const target = same ?? line ?? (frame >= FRAMES ? heading() : null);
      if (target) {
        target.focus({ preventScroll: true });
        // Keep the control's own label: the promote brings it back, and focus goes back to it.
        last.current = { element: target, label: was.label ?? labelOf(target) };
        return;
      }
      frame += 1;
      id = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(id);
    // `root` and `heading` are read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change]);
  return { onFocus };
}
