import { useCallback, useLayoutEffect, useRef, type FocusEvent } from 'react';

/** The attribute a section's lock or not-connected line carries so a handover can find it. */
export const FOCUS_LINE_ATTR = 'data-focus-line';

const FRAMES = 30;

/**
 * What names a control well enough to find it again after a remount: its aria-label, name or id,
 * else (round 13, review 10 MEDIUM-2) its tag and the words that label it: the elements
 * aria-labelledby names, or the <label> around it without the control's own text (a select's
 * options), so an unlabelled field in a wrapping label ("Media", "Corrected only") is found too.
 */
function labelOf(element: HTMLElement): string | null {
  const own = element.getAttribute('aria-label') || element.getAttribute('name') || element.id;
  if (own) return own;
  let words = '';
  const by = element.getAttribute('aria-labelledby');
  if (by) words = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  else {
    const label = element.closest('label');
    if (label) for (const node of label.childNodes) if (!node.contains(element)) words += ` ${node.textContent ?? ''}`;
  }
  words = words.replace(/\s+/g, ' ').trim();
  return words ? `${element.tagName.toLowerCase()}: ${words}` : null;
}

/** Every element labelOf can name: the focusable ones. */
const NAMED = 'input, select, textarea, button, a[href], summary, [tabindex], [aria-label], [name], [id]';

/**
 * PR #204 round 11 (review 9 MEDIUM-3, GM r19 item 2): when a demote (or the promote) takes away
 * the control that had focus, focus moves on instead of dropping to the page: to the same
 * control if it is back (the promote remounts it, matched by labelOf), else to the section's
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
        ? [...scope.querySelectorAll<HTMLElement>(NAMED)].find((el) => labelOf(el) === was.label
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
